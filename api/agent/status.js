import { getAgentRuntime } from '../../lib/agent/runtime.js';
import { applyCors, handleOptions, requireMethod, sendError, getSessionId } from '../../lib/agent/http.js';

export default async function handler(req, res) {
  applyCors(req, res);
  if (handleOptions(req, res)) return;
  if (!requireMethod(req, res, 'GET')) return;

  try {
    const sessionId = getSessionId(req);
    const taskId = req.query.taskId;
    const { orchestrator } = getAgentRuntime();
    const status = await orchestrator.status({ taskId, sessionId });

    if (!status) {
      return res.status(404).json({ error: 'No task status found', sessionId, taskId });
    }

    return res.status(200).json({ sessionId, ...status });
  } catch (error) {
    return sendError(res, error);
  }
}
