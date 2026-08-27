import { AGENT_PROTOCOLS, SYSTEM_PROMPTS } from './protocols.js';
import { routeAndGenerateReply } from '../modelRouter.js';

const LIFECYCLE = {
  planning: 'planning',
  executing: 'executing',
  reflecting: 'reflecting',
  reporting: 'reporting',
  blocked: 'blocked',
  failed: 'failed',
  complete: 'complete'
};

export class AgentOrchestrator {
  constructor({ store, logger, memory, costTracker, approval }) {
    this.store = store;
    this.logger = logger;
    this.memory = memory;
    this.costTracker = costTracker;
    this.approval = approval;
  }

  async planTask({ sessionId, task, budgetCents, metadata = {} }) {
    const steps = decomposeTask(task);
    const taskRow = await this.store.insert('agent_tasks', {
      session_id: sessionId,
      task,
      status: 'planned',
      lifecycle_state: LIFECYCLE.planning,
      budget_cents: budgetCents ?? null,
      decomposition: steps,
      progress: {
        total_steps: steps.length,
        completed_steps: 0,
        current_step_index: 0
      },
      metadata
    });

    await this.memory.addConversationMessage({
      sessionId,
      role: 'user',
      content: task,
      metadata: { task_id: taskRow.id }
    });

    await this.logger.log({
      taskId: taskRow.id,
      sessionId,
      state: LIFECYCLE.planning,
      thought: 'Analyze user objective and split it into deterministic micro-steps.',
      action: 'task_decomposition',
      observation: `Generated ${steps.length} planned steps`,
      metadata: { steps }
    });

    return {
      taskId: taskRow.id,
      lifecycle: LIFECYCLE.planning,
      steps
    };
  }

  async execute({ sessionId, taskId, input, approvedApprovalIds = [] }) {
    const task = await this.getTask(taskId);
    if (!task) throw new Error('Task not found');

    const budgetCheck = await this.costTracker.assertWithinBudget({
      taskId,
      sessionId,
      budgetCents: task.budget_cents
    });

    if (!budgetCheck.allowed) {
      await this.updateTask(taskId, {
        status: 'blocked',
        lifecycle_state: LIFECYCLE.blocked,
        failure_reason: 'Budget threshold exceeded'
      });
      return {
        taskId,
        state: LIFECYCLE.blocked,
        blockedReason: 'budget_threshold_exceeded',
        budget: budgetCheck
      };
    }

    const steps = Array.isArray(task.decomposition) ? task.decomposition : [];
    const progress = task.progress || { total_steps: steps.length, completed_steps: 0, current_step_index: 0 };
    const stepIndex = progress.current_step_index || 0;
    const step = steps[stepIndex];

    if (!step) {
      await this.updateTask(taskId, {
        status: 'complete',
        lifecycle_state: LIFECYCLE.complete
      });
      return {
        taskId,
        state: LIFECYCLE.complete,
        message: 'All planned steps have already completed.'
      };
    }

    const thought = `Current goal: ${step.goal}. Determine safe execution action.`;
    const action = step.operation;

    const approvalRecord = await this.approval.createApproval({
      taskId,
      sessionId,
      operation: `${action} ${step.goal}`,
      metadata: { stepIndex }
    });

    const needsApproval = approvalRecord.requires_approval && approvalRecord.status === 'pending';
    const alreadyApproved = approvedApprovalIds.includes(approvalRecord.id);
    if (needsApproval && !alreadyApproved) {
      await this.updateTask(taskId, {
        status: 'awaiting_approval',
        lifecycle_state: LIFECYCLE.blocked
      });
      await this.logger.log({
        taskId,
        sessionId,
        state: LIFECYCLE.blocked,
        thought,
        action,
        observation: 'Execution paused for approval gate.',
        metadata: { approval: approvalRecord }
      });

      return {
        taskId,
        state: LIFECYCLE.blocked,
        awaitingApproval: true,
        approval: approvalRecord
      };
    }

    if (alreadyApproved) {
      await this.approval.resolveApproval({
        approvalId: approvalRecord.id,
        decision: 'approve',
        decidedBy: 'user',
        notes: 'Pre-approved in execute request'
      });
    }

    await this.updateTask(taskId, {
      status: 'running',
      lifecycle_state: LIFECYCLE.executing
    });

    let modelResponse;
    let observation;
    let attempts = 0;

    while (attempts < 2) {
      attempts += 1;
      try {
        modelResponse = await routeAndGenerateReply(step.prompt || input || step.goal, {
          systemPrompt: `${SYSTEM_PROMPTS.orchestrator}\nProtocols:\n${flattenProtocols(AGENT_PROTOCOLS)}`,
          network: { timeoutMs: 8000, retries: 1 }
        });
        observation = modelResponse.reply;
        break;
      } catch (error) {
        observation = `Attempt ${attempts} failed: ${error.message}`;
        if (attempts >= 2) throw error;
      }
    }

    const cost = await this.costTracker.recordCost({
      taskId,
      sessionId,
      provider: modelResponse.provider,
      model: modelResponse.model,
      inputText: step.prompt || input || step.goal,
      outputText: observation
    });

    await this.memory.addConversationMessage({
      sessionId,
      role: 'assistant',
      content: observation,
      metadata: {
        task_id: taskId,
        step_index: stepIndex,
        model: modelResponse.model,
        provider: modelResponse.provider
      }
    });

    await this.logger.log({
      taskId,
      sessionId,
      state: LIFECYCLE.executing,
      thought,
      action,
      observation,
      metadata: {
        step,
        cost
      }
    });

    const nextProgress = {
      total_steps: steps.length,
      completed_steps: Math.min(steps.length, (progress.completed_steps || 0) + 1),
      current_step_index: stepIndex + 1
    };

    const done = nextProgress.completed_steps >= steps.length;

    await this.updateTask(taskId, {
      status: done ? 'complete' : 'running',
      lifecycle_state: done ? LIFECYCLE.reporting : LIFECYCLE.reflecting,
      progress: nextProgress,
      last_result: {
        thought,
        action,
        observation,
        model: modelResponse.model,
        provider: modelResponse.provider,
        cost_cents: cost.cost_cents
      }
    });

    await this.memory.compressConversation({ sessionId, keepRecent: 14 });

    if (done) {
      await this.memory.addLongTermMemory({
        taskId,
        sessionId,
        memoryType: 'task_outcome',
        content: `Task completed: ${task.task}`,
        metadata: {
          completed_steps: steps.length,
          cost_cents: cost.cost_cents
        }
      });
    }

    return {
      taskId,
      state: done ? LIFECYCLE.complete : LIFECYCLE.reflecting,
      stepIndex,
      totalSteps: steps.length,
      observation,
      cost
    };
  }

  async status({ taskId, sessionId }) {
    const task = taskId ? await this.getTask(taskId) : await this.getLatestTaskForSession(sessionId);
    if (!task) return null;

    const costs = await this.costTracker.getSummary({ taskId: task.id, sessionId: task.session_id });
    const pendingApprovals = await this.approval.list({ taskId: task.id, status: 'pending', limit: 20 });

    return {
      task,
      costs,
      pendingApprovals
    };
  }

  async getTask(taskId) {
    const rows = await this.store.select('agent_tasks', {
      filters: { id: taskId },
      limit: 1
    });
    return rows[0] || null;
  }

  async getLatestTaskForSession(sessionId) {
    if (!sessionId) return null;
    const rows = await this.store.select('agent_tasks', {
      filters: { session_id: sessionId },
      limit: 1,
      orderBy: 'created_at',
      ascending: false
    });
    return rows[0] || null;
  }

  async updateTask(taskId, patch) {
    const [updated] = await this.store.update('agent_tasks', { id: taskId }, patch);
    return updated || null;
  }
}

function decomposeTask(task = '') {
  const normalized = String(task || '').trim();
  if (!normalized) {
    return [createStep(0, 'Collect missing task context', 'analysis')];
  }

  const sentenceSteps = normalized
    .split(/\n|\.|;|\u2022|\-/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((goal, index) => createStep(index, goal, classifyOperation(goal)));

  if (sentenceSteps.length > 0) return sentenceSteps;

  return [
    createStep(0, `Analyze request: ${normalized}`, 'analysis'),
    createStep(1, 'Execute the safest next action', 'execution'),
    createStep(2, 'Reflect and report outcome', 'reporting')
  ];
}

function classifyOperation(goal) {
  const text = goal.toLowerCase();
  if (/(delete|remove|drop|revoke|deploy|commit|write|publish)/.test(text)) return 'sensitive_operation';
  if (/(plan|analy[sz]e|assess|review|design)/.test(text)) return 'analysis';
  return 'execution';
}

function createStep(index, goal, operation) {
  return {
    index,
    goal,
    operation,
    prompt: `Step ${index + 1}: ${goal}`,
    status: 'pending'
  };
}

function flattenProtocols(protocols) {
  return Object.entries(protocols)
    .map(([area, rules]) => `${area}: ${rules.join(' | ')}`)
    .join('\n');
}
