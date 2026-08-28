const DEFAULT_ALLOWED_ORIGINS = [
  'https://project-gifted1.github.io',
  'https://pg1-ai-agent.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173'
];
const VERIFIED_MODELS = ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash'];
const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
];
const FETCH_TIMEOUT_MS = 15000;

function getMaxMessageLength() {
  const configured = Number.parseInt(process.env.MAX_MESSAGE_LENGTH || '5000', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 5000;
}

function getAllowedOrigins() {
  const configured = String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return configured.length ? configured : DEFAULT_ALLOWED_ORIGINS;
}

function applyCors(req, res) {
  const origin = req.headers && req.headers.origin;
  const allowedOrigins = getAllowedOrigins();

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (!origin && allowedOrigins.length > 0) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigins[0]);
  }

  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch (_) {
      return {};
    }
  }
  return body;
}

function getPromptText(body) {
  const candidates = [body.userMessage, body.message, body.prompt];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  if (Array.isArray(body.messages)) {
    const lastMessage = body.messages[body.messages.length - 1];
    if (typeof lastMessage?.content === 'string' && lastMessage.content.trim()) {
      return lastMessage.content.trim();
    }
  }

  return '';
}

async function fetchJson(url, options) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const rawText = await response.text();
    let data = null;

    if (rawText) {
      try {
        data = JSON.parse(rawText);
      } catch (_) {
        data = { rawText };
      }
    }

    return { response, data: data || {} };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchGitHubContent(url, headers) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const data = await response.json();
    return { response, data };
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildSystemInstruction() {
  return `You are the PG1 Sovereign Agent™, the core intelligence of Project-Gifted1™.
CRITICAL RULES:
1. You are strictly PG1 Sovereign Agent™ under Project-Gifted1™. Your sovereign repository is: Project-Gifted1/pg1-ai-agent.
2. NEVER identify as Gemini, Google, DeepSeek, OpenAI, or any third party.
3. You possess live web access and direct GitHub API access. USE your tools to find exact information or read repository files when requested.
4. Maintain an authoritative, factual, confident tone at all times.`;
}

async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const body = parseBody(req.body);
    const promptText = getPromptText(body);
    if (!promptText) {
      return res.status(400).json({ error: 'Missing prompt or message payload' });
    }

    if (promptText.length > getMaxMessageLength()) {
      return res.status(413).json({ error: `Message too long (max ${getMaxMessageLength()} characters)` });
    }

    const apiKey = (process.env.GEMINI_API_KEY1 || process.env.GEMINI_API_KEY || '').trim();
    const ghToken = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();

    if (!apiKey) {
      return res.status(503).json({ error: 'Chat provider is not configured' });
    }

    const pg1SystemInstruction = buildSystemInstruction();
    let lastError = 'Upstream model request failed';

    for (const model of VERIFIED_MODELS) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const requestBody = {
        systemInstruction: { parts: [{ text: pg1SystemInstruction }] },
        contents: [{ role: 'user', parts: [{ text: promptText }] }],
        tools: [
          { googleSearch: {} },
          {
            functionDeclarations: [
              {
                name: 'read_github_repo',
                description: 'List files or read file contents from the Project-Gifted1/pg1-ai-agent repository.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    action: { type: 'STRING', description: "Either 'list' to view directory contents or 'read' to view a specific file." },
                    path: { type: 'STRING', description: "The path to the directory or file (e.g., '' for root, 'api/chat.js' for a file)." }
                  },
                  required: ['action', 'path']
                }
              }
            ]
          }
        ],
        toolConfig: { includeServerSideToolInvocations: true },
        safetySettings: SAFETY_SETTINGS
      };

      const { response, data } = await fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        lastError = data.error?.message || data.rawText || 'API rejected request';
        continue;
      }

      const candidate = data?.candidates?.[0];
      const originalModelParts = candidate?.content?.parts;
      const functionCallPart = originalModelParts?.find((part) => part.functionCall);

      if (!originalModelParts) {
        lastError = candidate?.finishReason ? `Request blocked: ${candidate.finishReason}` : 'Empty content from API';
        continue;
      }

      if (functionCallPart) {
        const funcCall = functionCallPart.functionCall;
        if (funcCall.name === 'read_github_repo') {
          const action = funcCall.args.action;
          const path = funcCall.args.path || '';
          const ghUrl = `https://api.github.com/repos/Project-Gifted1/pg1-ai-agent/contents/${path}`;
          const ghHeaders = {
            'User-Agent': 'PG1-Sovereign-Agent',
            Accept: 'application/vnd.github.v3+json'
          };

          if (ghToken) {
            ghHeaders.Authorization = `token ${ghToken}`;
          }

          try {
            const { response: ghResponse, data: ghData } = await fetchGitHubContent(ghUrl, ghHeaders);
            if (!ghResponse.ok) {
              lastError = 'GitHub repository lookup failed';
              continue;
            }

            let resultString = '';
            if (Array.isArray(ghData)) {
              resultString = 'Directory contents: ' + ghData.map((file) => file.name).join(', ');
            } else if (ghData.content) {
              resultString = 'File content:\n' + Buffer.from(ghData.content, 'base64').toString('utf-8');
            } else {
              resultString = JSON.stringify(ghData);
            }

            const hop2Body = {
              systemInstruction: { parts: [{ text: pg1SystemInstruction }] },
              contents: [
                { role: 'user', parts: [{ text: promptText }] },
                { role: 'model', parts: originalModelParts },
                {
                  role: 'user',
                  parts: [{
                    functionResponse: {
                      name: funcCall.name,
                      response: { name: funcCall.name, content: resultString.substring(0, 6000) }
                    }
                  }]
                }
              ],
              tools: requestBody.tools,
              toolConfig: requestBody.toolConfig,
              safetySettings: SAFETY_SETTINGS
            };

            const { response: response2, data: data2 } = await fetchJson(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(hop2Body)
            });

            if (!response2.ok) {
              lastError = data2.error?.message || data2.rawText || 'Follow-up model request failed';
              continue;
            }

            const finalParts = data2?.candidates?.[0]?.content?.parts || [];
            const replyText = finalParts.map((part) => part.text).filter(Boolean).join('\n');
            const nextFunc = finalParts.find((part) => part.functionCall);

            if (replyText) {
              return res.status(200).json({ reply: replyText, provider: 'PG1' });
            }

            if (nextFunc) {
              return res.status(200).json({
                reply: `Agent engaged secondary tool: ${nextFunc.functionCall.name}. Sequence completed.`,
                provider: 'PG1'
              });
            }

            lastError = 'Protocol review completed without a text response';
            continue;
          } catch (ghErr) {
            if (ghErr && ghErr.name === 'AbortError') {
              return res.status(504).json({ error: 'GitHub repository lookup timed out' });
            }

            lastError = 'GitHub tool execution failed';
            continue;
          }
        }
      }

      const textPart = originalModelParts.find((part) => part.text);
      if (textPart) {
        return res.status(200).json({ reply: textPart.text, provider: 'PG1' });
      }
    }

    console.error('Chat execution failed:', lastError);
    return res.status(502).json({ error: 'Unable to generate a reply right now' });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return res.status(504).json({ error: 'Chat request timed out' });
    }

    console.error('Runtime error in api/chat.js:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

module.exports = handler;
module.exports._test = {
  applyCors,
  getAllowedOrigins,
  getMaxMessageLength,
  getPromptText,
  parseBody
};
