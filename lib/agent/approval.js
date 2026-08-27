const SENSITIVE_KEYWORDS = [
  'delete',
  'remove',
  'deploy',
  'production',
  'database',
  'credential',
  'secret',
  'permission',
  'write',
  'commit'
];

export class ApprovalManager {
  constructor(store) {
    this.store = store;
  }

  evaluate(operation = '') {
    const normalized = String(operation).toLowerCase();
    const matched = SENSITIVE_KEYWORDS.filter((keyword) => normalized.includes(keyword));
    const riskScore = Math.min(100, matched.length * 18 + (normalized.includes('production') ? 20 : 0));
    const requiresApproval = riskScore >= 25;

    return {
      requiresApproval,
      riskScore,
      matched
    };
  }

  async createApproval({ taskId, sessionId, operation, metadata = {} }) {
    const analysis = this.evaluate(operation);
    const row = {
      task_id: taskId,
      session_id: sessionId,
      operation,
      metadata,
      risk_score: analysis.riskScore,
      requires_approval: analysis.requiresApproval,
      status: analysis.requiresApproval ? 'pending' : 'auto-approved'
    };

    const saved = await this.store.insert('agent_approvals', row);
    return { ...saved, analysis };
  }

  async resolveApproval({ approvalId, decision, decidedBy = 'user', notes = '' }) {
    const status = decision === 'approve' ? 'approved' : 'rejected';
    const [updated] = await this.store.update('agent_approvals', { id: approvalId }, {
      status,
      decided_by: decidedBy,
      decision_notes: notes,
      decided_at: new Date().toISOString()
    });

    return updated || null;
  }

  async list({ taskId, sessionId, status, limit = 100 }) {
    const filters = {};
    if (taskId) filters.task_id = taskId;
    if (sessionId) filters.session_id = sessionId;
    if (status) filters.status = status;
    return this.store.select('agent_approvals', { filters, limit, orderBy: 'created_at', ascending: false });
  }
}
