import { routeAndGenerateReply } from '../lib/modelRouter.js';

const MAX_MESSAGE_LENGTH = Number(process.env.MAX_MESSAGE_LENGTH || 5000);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://pg1-ai-agent.vercel.app,http://localhost:3000,http://localhost:5173')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (!origin && ALLOWED_ORIGINS.length > 0) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS[0]);
  }

  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  return body;
}

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const body = parseBody(req.body);
    const userMessage = String(body.prompt || body.messages?.[body.messages.length - 1]?.content || '').trim();

    if (!userMessage) {
      return res.status(400).json({ error: 'Missing prompt or message payload' });
    }

    if (userMessage.length > MAX_MESSAGE_LENGTH) {
      return res.status(413).json({ error: `Message too long. Max characters: ${MAX_MESSAGE_LENGTH}` });
    }

    const routed = await routeAndGenerateReply(userMessage, {
      systemPrompt: 'You are the PG1 Sovereign AI Agent. Provide precise, direct, and actionable solutions.',
      network: { timeoutMs: 8000, retries: 2 }
    });

    return res.status(200).json({
      reply: routed.reply,
      provider: routed.provider,
      model: routed.model,
      complexity: routed.complexity
    });
  } catch (error) {
    console.error('Routing execution error:', error.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
