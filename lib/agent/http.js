const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:3000', 'http://localhost:5173', 'https://pg1-ai-agent.vercel.app'];

export function applyCors(req, res) {
  const configured = process.env.AGENT_ALLOWED_ORIGINS
    ? process.env.AGENT_ALLOWED_ORIGINS.split(',').map((item) => item.trim()).filter(Boolean)
    : DEFAULT_ALLOWED_ORIGINS;

  const requestOrigin = req.headers.origin;
  if (requestOrigin && configured.includes(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
  } else if (!requestOrigin) {
    res.setHeader('Access-Control-Allow-Origin', configured[0]);
  }

  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export function handleOptions(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }
  return false;
}

export function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

export function requireMethod(req, res, allowedMethod) {
  if (req.method !== allowedMethod) {
    res.status(405).json({ error: `Method ${req.method} Not Allowed` });
    return false;
  }
  return true;
}

export function sendError(res, error, status = 500) {
  console.error('[agent-api] error', error);
  res.status(status).json({
    error: status >= 500 ? 'Internal Server Error' : error.message,
    details: status >= 500 ? undefined : error.message
  });
}

export function getSessionId(req, fallbackPrefix = 'session') {
  const body = parseBody(req);
  return req.query.sessionId || body.sessionId || `${fallbackPrefix}-${Date.now()}`;
}
