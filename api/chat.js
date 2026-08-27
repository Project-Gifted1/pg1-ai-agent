// --- Constants ---
const MAX_MESSAGE_LENGTH = 5000;
const GEMINI_MODEL = 'gemini-1.5-flash';
const OPENROUTER_MODEL = 'deepseek/deepseek-chat';
const FETCH_TIMEOUT_MS = 8000;

/**
 * Trusted origins for CORS. Falls back to the Vercel deployment URL env var,
 * then the production domain.
 */
const ALLOWED_ORIGINS = [
  process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null,
  'https://pg1-ai-agent.vercel.app',
].filter(Boolean);

/**
 * Determines whether a message should be routed to the more capable model.
 * Uses message length and presence of code blocks rather than keyword matching
 * to avoid false positives (e.g. "decode" triggering on "code").
 * @param {string} message
 * @returns {boolean}
 */
function isComplexMessage(message) {
  return message.length > 500 || message.includes('```');
}

/**
 * Creates an AbortController that automatically aborts after the given timeout.
 * @param {number} ms - Timeout in milliseconds.
 * @returns {{ controller: AbortController, timeoutId: ReturnType<typeof setTimeout> }}
 */
function createFetchTimeout(ms) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return { controller, timeoutId };
}

/**
 * Main Vercel API handler. Routes chat requests to Gemini (complex) or
 * OpenRouter/DeepSeek (simple) based on message characteristics.
 * @param {import('@vercel/node').VercelRequest} req
 * @param {import('@vercel/node').VercelResponse} res
 */
export default async function handler(req, res) {
  // --- CORS ---
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // --- Request logging ---
  console.log(`[chat] ${new Date().toISOString()} origin=${origin || 'unknown'}`);

  try {
    const { prompt, messages } = req.body || {};

    // --- Input validation ---
    const rawMessage = prompt ?? messages?.[messages.length - 1]?.content;

    if (rawMessage === undefined || rawMessage === null || rawMessage === '') {
      return res.status(400).json({ error: 'Missing prompt or message payload' });
    }

    if (typeof rawMessage !== 'string') {
      return res.status(400).json({ error: 'Message must be a string' });
    }

    if (rawMessage.length > MAX_MESSAGE_LENGTH) {
      return res.status(413).json({ error: 'Message too long. Maximum length is 5000 characters.' });
    }

    const userMessage = rawMessage;
    const sysPrompt = 'You are the PG1 Sovereign AI Agent. Provide precise, direct, and actionable solutions.';

    let headers = { 'Content-Type': 'application/json' };

    if (isComplexMessage(userMessage)) {
      // --- Gemini Route ---
      const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
      if (!apiKey) {
        console.error('[chat] GEMINI_API_KEY is not configured');
        return res.status(500).json({ error: 'Server configuration error' });
      }

      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
      const payload = {
        systemInstruction: { parts: [{ text: sysPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userMessage }] }]
      };

      const { controller, timeoutId } = createFetchTimeout(FETCH_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(apiUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[chat] Gemini API error (${response.status}):`, errorText);
        return res.status(502).json({ error: 'Upstream API request failed' });
      }

      const data = await response.json();
      const outputText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return res.status(200).json({ reply: outputText, provider: 'gemini', model: GEMINI_MODEL });

    } else {
      // --- OpenRouter / DeepSeek Route ---
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        console.error('[chat] OPENROUTER_API_KEY is not configured');
        return res.status(500).json({ error: 'Server configuration error' });
      }

      const apiUrl = 'https://openrouter.ai/api/v1/chat/completions';
      headers['Authorization'] = 'Bearer ' + apiKey;

      const payload = {
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: userMessage }
        ]
      };

      const { controller, timeoutId } = createFetchTimeout(FETCH_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(apiUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[chat] OpenRouter API error (${response.status}):`, errorText);
        return res.status(502).json({ error: 'Upstream API request failed' });
      }

      const data = await response.json();
      const outputText = data.choices?.[0]?.message?.content || '';
      return res.status(200).json({ reply: outputText, provider: 'openrouter', model: OPENROUTER_MODEL });
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('[chat] Request timed out');
      return res.status(504).json({ error: 'Request timed out' });
    }
    console.error('[chat] Unhandled error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
