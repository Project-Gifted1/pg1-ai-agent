import { getAgentRuntime } from '../lib/agent/runtime.js';
import { applyCors, handleOptions, parseBody, sendError, getSessionId } from '../lib/agent/http.js';

const GET_ACTIONS = new Set(['status', 'memory', 'logs', 'costs']);
const POST_ACTIONS = new Set(['plan', 'execute', 'approve']);

export default async function handler(req, res) {
  applyCors(req, res);
  if (handleOptions(req, res)) return;

  try {
    const body = parseBody(req);
    const action = String(req.query.action || body.action || '').toLowerCase();

    if (req.method === 'GET') {
      if (!GET_ACTIONS.has(action)) {
        return res.status(400).json({ error: 'Unsupported GET action', supported: [...GET_ACTIONS] });
      }
      return handleGet(action, req, res);
    }

    if (req.method === 'POST') {
      if (!POST_ACTIONS.has(action)) {
        return res.status(400).json({ error: 'Unsupported POST action', supported: [...POST_ACTIONS] });
      }
      return handlePost(action, req, res, body);
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (error) {
    return sendError(res, error);
  }
}

async function handleGet(action, req, res) {
  const runtime = getAgentRuntime();
  const sessionId = getSessionId(req);
  const taskId = req.query.taskId;

  if (action === 'status') {
    const status = await runtime.orchestrator.status({ taskId, sessionId });
    return res.status(200).json(status || { task: null, costs: { count: 0, total_cost_cents: 0 }, pendingApprovals: [] });
  }

  if (action === 'memory') {
    const q = String(req.query.q || '');
    const memories = await runtime.memory.queryLongTermMemory({ sessionId, query: q, limit: Number(req.query.limit || 20) });
    return res.status(200).json({ memories });
  }

  if (action === 'logs') {
    const logs = await runtime.logger.list({ taskId, sessionId, limit: Number(req.query.limit || 200) });
    return res.status(200).json({ logs });
  }

  if (action === 'costs') {
    const costs = await runtime.costTracker.getSummary({ taskId, sessionId });
    return res.status(200).json(costs);
  }
}

async function handlePost(action, req, res, body) {
  const runtime = getAgentRuntime();
  const sessionId = getSessionId(req);

  if (action === 'plan') {
    if (!body.task && !body.prompt) {
      return res.status(400).json({ error: 'task is required' });
    }
    const result = await runtime.orchestrator.planTask({
      sessionId,
      task: body.task || body.prompt,
      budgetCents: body.budgetCents,
      metadata: body.metadata || {}
    });
    return res.status(200).json({ sessionId, ...result });
  }

  if (action === 'execute') {
    if (!body.taskId) {
      return res.status(400).json({ error: 'taskId is required' });
    }
    const result = await runtime.orchestrator.execute({
      sessionId,
      taskId: body.taskId,
      input: body.input || body.prompt,
      approvedApprovalIds: Array.isArray(body.approvedApprovalIds) ? body.approvedApprovalIds : []
    });
    return res.status(200).json({ sessionId, ...result });
  }

  if (action === 'approve') {
    if (!body.approvalId) {
      return res.status(400).json({ error: 'approvalId is required' });
    }
    const result = await runtime.approval.resolveApproval({
      approvalId: body.approvalId,
      decision: body.decision === 'deny' ? 'deny' : 'approve',
      decidedBy: body.decidedBy || 'user',
      notes: body.notes || ''
    });
    return res.status(200).json({ approval: result });
  }
}
