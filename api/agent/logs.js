import { getAgentRuntime } from '../../lib/agent/runtime.js';
import { applyCors, handleOptions, requireMethod, sendError, getSessionId } from '../../lib/agent/http.js';

export default async function handler(req, res) {
  applyCors(req, res);
  if (handleOptions(req, res)) return;
  if (!requireMethod(req, res, 'GET')) return;

  try {
    const taskId = req.query.taskId;
    const sessionId = getSessionId(req);
    const limit = Number(req.query.limit || 200);
    const { logger } = getAgentRuntime();
    const logs = await logger.list({ taskId, sessionId, limit });
    return res.status(200).json({ taskId, sessionId, logs });
  } catch (error) {
    return sendError(res, error);
  }
}
