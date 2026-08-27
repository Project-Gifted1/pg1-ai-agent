import { getAgentRuntime } from '../../lib/agent/runtime.js';
import { applyCors, handleOptions, parseBody, requireMethod, sendError } from '../../lib/agent/http.js';

export default async function handler(req, res) {
  applyCors(req, res);
  if (handleOptions(req, res)) return;
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const body = parseBody(req);
    if (!body.approvalId) {
      return res.status(400).json({ error: 'approvalId is required' });
    }

    const decision = body.decision === 'deny' ? 'deny' : 'approve';
    const { approval } = getAgentRuntime();
    const result = await approval.resolveApproval({
      approvalId: body.approvalId,
      decision,
      decidedBy: body.decidedBy || 'user',
      notes: body.notes || ''
    });

    if (!result) {
      return res.status(404).json({ error: 'Approval record not found' });
    }

    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error);
  }
}
