import { getAgentRuntime } from '../../lib/agent/runtime.js';
import { applyCors, handleOptions, parseBody, requireMethod, sendError, getSessionId } from '../../lib/agent/http.js';

export default async function handler(req, res) {
  applyCors(req, res);
  if (handleOptions(req, res)) return;
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const body = parseBody(req);
    const taskId = body.taskId;
    if (!taskId) {
      return res.status(400).json({ error: 'taskId is required' });
    }

    const sessionId = getSessionId(req);
    const { orchestrator } = getAgentRuntime();
    const result = await orchestrator.execute({
      sessionId,
      taskId,
      input: body.input || body.prompt,
      approvedApprovalIds: Array.isArray(body.approvedApprovalIds) ? body.approvedApprovalIds : []
    });

    return res.status(200).json({ sessionId, ...result });
  } catch (error) {
    return sendError(res, error);
  }
}
