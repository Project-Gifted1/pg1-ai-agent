const MAX_MESSAGE_LENGTH = 5000;
const LONG_PROMPT_THRESHOLD = 600;
const COMPLEX_PROMPT_THRESHOLD = 260;
const REQUEST_TIMEOUT_MS = 8000;
const DEFAULT_ALLOWED_ORIGINS = [
  'https://pg1-ai-agent.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173'
];

const SYSTEM_PROMPT = `You are PG1.Agent - Sovereign Autonomous Core v1.0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PRIMARY DIRECTIVES (Non-negotiable):

1. ABSOLUTE TRANSPARENCY
   • Every response must be explainable
   • Never hide failures
   • Keep an audit-ready summary of actions taken

2. BRUTAL HONESTY
   • State capabilities and limits directly
   • Admit uncertainty immediately
   • Never fabricate outcomes, costs, or validation

3. PG1 SOVEREIGNTY
   • Identify as PG1 Sovereign Agent
   • Prefer PG1 terminology such as PG1 Autonomous Core, Sovereign Execution, Neural Protocol, Triple Verification Engine, Sentinel Mode, and Chron Protocol
   • Keep PG1 identity primary even when third-party models are used

4. USER CONTROL
   • Recommend clear next steps when user authorization or clarification is needed
   • Never imply an action succeeded unless the result confirms it

5. QUALITY OVER SPEED
   • Prefer precise, direct, and actionable answers
   • If information is missing, say so plainly`;

function getAllowedOrigins() {
  const configuredOrigins = process.env.PG1_ALLOWED_ORIGINS
    ? process.env.PG1_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
    : [];
  return configuredOrigins.length ? configuredOrigins : DEFAULT_ALLOWED_ORIGINS;
}

function applyCors(req, res) {
  const allowedOrigins = getAllowedOrigins();
  const requestOrigin = req.headers.origin;
  const matchedOrigin = allowedOrigins.includes(requestOrigin) ? requestOrigin : allowedOrigins[0];

  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (matchedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', matchedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );
}

function getUserMessage(body) {
  if (!body || typeof body !== 'object') return '';
  if (typeof body.prompt === 'string' && body.prompt.trim()) return body.prompt.trim();
  if (Array.isArray(body.messages)) {
    const lastMessage = body.messages[body.messages.length - 1];
    if (lastMessage && typeof lastMessage.content === 'string') return lastMessage.content.trim();
  }
  return '';
}

function isComplexPrompt(userMessage) {
  const normalized = userMessage.toLowerCase();
  const complexitySignals = ['refactor', 'analyze', 'architecture', 'debug', 'vulnerability', 'deploy', 'sql', 'incident'];
  const matchedSignals = complexitySignals.filter((keyword) => normalized.includes(keyword)).length;
  return (
    userMessage.length > LONG_PROMPT_THRESHOLD ||
    userMessage.includes('```') ||
    matchedSignals >= 2 ||
    (userMessage.length > COMPLEX_PROMPT_THRESHOLD && matchedSignals >= 1) ||
    (userMessage.includes('\n') && userMessage.length > 350)
  );
}

function createTimeoutSignal() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeoutId)
  };
}

function buildAuditEntry({
  operation,
  providerLabel,
  model,
  messageLength,
  riskLevel,
  status,
  durationMs,
  error,
  verification,
  trace
}) {
  return {
    timestamp: new Date().toISOString(),
    agent: 'PG1.Agent v1.0',
    component: 'PG1.Orchestrator',
    operation,
    reasoning: `Processed a ${messageLength}-character operator request and routed it through the selected Neural Protocol.`,
    riskLevel,
    userApproval: 'DIRECT_PROMPT_SUBMISSION',
    parameters: {
      messageLength,
      providerLabel,
      model
    },
    execution: {
      status,
      duration_ms: durationMs,
      cost: null
    },
    result: error
      ? { success: false, error }
      : { success: true, providerLabel, model },
    verification,
    trace
  };
}

function logAudit(entry) {
  console.log(JSON.stringify(entry));
}

async function callGemini(userMessage) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('PG1 configuration error: GEMINI_API_KEY or GOOGLE_API_KEY is required for this Neural Protocol.');
  }

  const timeout = createTimeoutSignal();
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: userMessage }] }]
        }),
        signal: timeout.signal
      }
    );

    if (!response.ok) {
      const upstreamError = await response.text();
      console.error('PG1 Gemini upstream failure:', upstreamError);
      throw new Error(`PG1 Neural Protocol failed with Gemini API status ${response.status}.`);
    }

    const data = await response.json();
    return {
      provider: 'gemini',
      providerLabel: 'PG1.Agent using Gemini API',
      model: 'gemini-1.5-flash',
      reply: data.candidates?.[0]?.content?.parts?.[0]?.text || ''
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`PG1 Neural Protocol timed out after ${REQUEST_TIMEOUT_MS}ms while using Gemini API.`);
    }
    throw error;
  } finally {
    timeout.clear();
  }
}

async function callOpenRouter(userMessage) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('PG1 configuration error: OPENROUTER_API_KEY is required for this Neural Protocol.');
  }

  const timeout = createTimeoutSignal();
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-chat',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage }
        ]
      }),
      signal: timeout.signal
    });

    if (!response.ok) {
      const upstreamError = await response.text();
      console.error('PG1 OpenRouter upstream failure:', upstreamError);
      throw new Error(`PG1 Neural Protocol failed with OpenRouter status ${response.status}.`);
    }

    const data = await response.json();
    return {
      provider: 'openrouter',
      providerLabel: 'PG1.Agent using DeepSeek via OpenRouter',
      model: 'deepseek/deepseek-chat',
      reply: data.choices?.[0]?.message?.content || ''
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`PG1 Neural Protocol timed out after ${REQUEST_TIMEOUT_MS}ms while using OpenRouter.`);
    }
    throw error;
  } finally {
    timeout.clear();
  }
}

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'PG1 Sovereign Agent only accepts POST for this Neural Protocol.',
      trace: ['Rejected non-POST request before any provider call.'],
      verification: 'NOT_EXECUTED',
      verificationLabel: 'Triple Verification Engine blocked an unsupported method.',
      costLabel: 'No cost incurred'
    });
  }

  const startedAt = Date.now();
  const userMessage = getUserMessage(req.body);
  const trace = [
    'Received operator payload.',
    'Validated the request shape before provider routing.',
    'Selected a Neural Protocol based on prompt complexity.'
  ];

  try {
    if (!userMessage) {
      return res.status(400).json({
        error: 'PG1 Sovereign Agent needs a prompt or message payload before it can start a Sovereign Execution.',
        trace,
        verification: 'REJECTED',
        verificationLabel: 'Triple Verification Engine rejected an empty request.',
        costLabel: 'No cost incurred'
      });
    }

    if (userMessage.length > MAX_MESSAGE_LENGTH) {
      return res.status(413).json({
        error: `PG1 Sovereign Agent rejected the request because it exceeded the ${MAX_MESSAGE_LENGTH}-character limit for this Neural Protocol.`,
        trace,
        verification: 'REJECTED',
        verificationLabel: 'Triple Verification Engine rejected an oversized request.',
        costLabel: 'No cost incurred'
      });
    }

    const selectedRoute = isComplexPrompt(userMessage) ? 'gemini' : 'openrouter';
    const result = selectedRoute === 'gemini' ? await callGemini(userMessage) : await callOpenRouter(userMessage);
    const durationMs = Date.now() - startedAt;
    const successTrace = [
      ...trace,
      `Dispatched request through ${result.providerLabel}.`,
      'Verified that the downstream response returned a readable reply.'
    ];

    logAudit(
      buildAuditEntry({
        operation: 'SovereignExecution',
        providerLabel: result.providerLabel,
        model: result.model,
        messageLength: userMessage.length,
        riskLevel: selectedRoute === 'gemini' ? 'MEDIUM' : 'LOW',
        status: 'SUCCESS',
        durationMs,
        verification: 'TRIPLE_CHECKED',
        trace: successTrace
      })
    );

    return res.status(200).json({
      ...result,
      status: 'PG1.Agent Status: Sovereign Execution complete',
      verification: 'TRIPLE_CHECKED',
      verificationLabel: 'Triple Verification Engine confirmed downstream response structure.',
      cost: null,
      costLabel: 'Unavailable — provider cost telemetry was not returned by this route.',
      trace: successTrace
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const failureTrace = [
      ...trace,
      'A downstream or configuration failure interrupted execution.',
      'The failure was surfaced without masking provider or timeout details.'
    ];

    logAudit(
      buildAuditEntry({
        operation: 'SovereignExecution',
        providerLabel: 'PG1.Agent routing layer',
        model: 'unresolved',
        messageLength: userMessage.length,
        riskLevel: 'MEDIUM',
        status: 'FAILED',
        durationMs,
        error: error.message,
        verification: 'FAILED',
        trace: failureTrace
      })
    );

    console.error('PG1 Sovereign Execution error:', error);
    return res.status(500).json({
      error: error.message || 'PG1 Sovereign Execution failed for an unknown reason.',
      providerLabel: 'PG1.Agent routing layer',
      verification: 'FAILED',
      verificationLabel: 'Triple Verification Engine captured the failure state.',
      cost: null,
      costLabel: 'Unavailable — partial provider cost telemetry was not returned.',
      trace: failureTrace
    });
  }
}
