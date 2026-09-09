export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
    maxDuration: 60,
  },
};

export default async function handler(req, res) {
  const requestTraceId = Math.random().toString(36).substring(2, 10);

  const sendJSON = (status, data) => {
    if (res && typeof res.status === 'function') {
      return res.status(status).json(data);
    }
    return new Response(JSON.stringify(data), {
      status: status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key'
      }
    });
  };

  if (res && typeof res.setHeader === 'function') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
  }

  if (req.method === 'OPTIONS') {
    if (res && typeof res.status === 'function') return res.status(200).end();
    return new Response(null, { status: 200 });
  }

  if (req.method !== 'POST' && req.method !== 'GET') {
    return sendJSON(405, { error: 'Method Not Allowed', traceId: requestTraceId });
  }

  try {
    let body = {};
    if (req.method === 'POST') {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    }

    const userMessage = body.message || body.prompt || 'Hello';
    
    // Mandatory Anti-Truncation & Diff Safety Gate
    const incomingCode = body.pendingCode || '';
    if (incomingCode.length > 0 && incomingCode.length < 500 && !incomingCode.includes('export default')) {
      return sendJSON(400, {
        error: 'Anti-Truncation Safety Block: Submitted code is suspiciously small and risks deleting core logic. Full module delivery required.'
      });
    }

    const responsePayload = {
      success: true,
      reply: `PG1-AGENT // Sovereign Core // Anti-Truncation Protection Active.\n\nProcessed request: "${userMessage}". Safety validation passed successfully.`,
      audioEnabled: true,
      ttsEngine: 'Cartesia/OpenAI',
      traceId: requestTraceId
    };

    return sendJSON(200, responsePayload);

  } catch (err) {
    return sendJSON(500, { error: `Internal Server Error: ${err.message}`, traceId: requestTraceId });
  }
}
