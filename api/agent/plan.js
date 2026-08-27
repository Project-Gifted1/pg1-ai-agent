import { getAgentRuntime } from '../../lib/agent/runtime.js';
import { applyCors, handleOptions, parseBody, requireMethod, sendError, getSessionId } from '../../lib/agent/http.js';

export default async function handler(req, res) {
  applyCors(req, res);
  if (handleOptions(req, res)) return;
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const body = parseBody(req);
    const task = String(body.task || body.prompt || '').trim();
    if (!task) {
      return res.status(400).json({ error: 'task is required' });
    }

    const sessionId = getSessionId(req);
    const { orchestrator } = getAgentRuntime();
    const plan = await orchestrator.planTask({
      sessionId,
      task,
      budgetCents: body.budgetCents,
      metadata: body.metadata || {}
    });

    return res.status(200).json({
      sessionId,
      ...plan
    });
  } catch (error) {
    return sendError(res, error);
  }
}
