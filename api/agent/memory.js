import { getAgentRuntime } from '../../lib/agent/runtime.js';
import { applyCors, handleOptions, parseBody, requireMethod, sendError, getSessionId } from '../../lib/agent/http.js';

export default async function handler(req, res) {
  applyCors(req, res);
  if (handleOptions(req, res)) return;

  const { memory } = getAgentRuntime();

  try {
    if (req.method === 'GET') {
      const sessionId = getSessionId(req);
      const query = String(req.query.q || '');
      const limit = Number(req.query.limit || 20);
      const memories = await memory.queryLongTermMemory({ sessionId, query, limit });
      const context = await memory.getConversationContext({ sessionId, limit: Math.min(limit, 30) });
      return res.status(200).json({ sessionId, memories, context });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const sessionId = getSessionId(req);
      const content = String(body.content || '').trim();
      if (!content) {
        return res.status(400).json({ error: 'content is required' });
      }

      const saved = await memory.addLongTermMemory({
        taskId: body.taskId,
        sessionId,
        memoryType: body.memoryType || 'note',
        content,
        metadata: body.metadata || {}
      });
      return res.status(201).json(saved);
    }

    return requireMethod(req, res, 'GET');
  } catch (error) {
    return sendError(res, error);
  }
}
