const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_RETRIES = 2;

const GEMINI_COMPLEXITY_HINTS = [/```/, /\b(refactor|architecture|analy[sz]e|debug|design|sql|security|vulnerability|deploy)\b/i];

export function determineComplexity(message = '') {
  const normalized = String(message || '').trim();
  const isLong = normalized.length > 500;
  const hasCode = normalized.includes('```');
  const hasComplexTerms = GEMINI_COMPLEXITY_HINTS.some((pattern) => pattern.test(normalized));
  return {
    isComplex: isLong || hasCode || hasComplexTerms,
    reason: isLong ? 'length' : hasCode ? 'code-block' : hasComplexTerms ? 'complex-keywords' : 'simple'
  };
}

export async function fetchWithRetry(url, options = {}, { retries = DEFAULT_RETRIES, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok && response.status >= 500 && attempt < retries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      return response;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt >= retries) throw error;
      await sleep(backoffMs(attempt));
    }
  }
  throw lastError || new Error('Unknown fetch error');
}

export async function routeAndGenerateReply(userMessage, options = {}) {
  const message = String(userMessage || '');
  const complexity = determineComplexity(message);

  if (complexity.isComplex) {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error('Gemini provider is not configured');
    const model = options.geminiModel || 'gemini-1.5-flash';
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const payload = {
      systemInstruction: {
        parts: [{ text: options.systemPrompt || 'You are the PG1 Sovereign AI Agent. Provide precise, actionable responses.' }]
      },
      contents: [{ role: 'user', parts: [{ text: message }] }]
    };

    const response = await fetchWithRetry(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, options.network);

    if (!response.ok) {
      const body = await response.text();
      throw redactProviderError('gemini', response.status, body);
    }

    const data = await response.json();
    return {
      reply: data.candidates?.[0]?.content?.parts?.[0]?.text || '',
      provider: 'gemini',
      model,
      complexity
    };
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OpenRouter provider is not configured');

  const model = options.openRouterModel || 'deepseek/deepseek-chat';
  const response = await fetchWithRetry('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: options.systemPrompt || 'You are the PG1 Sovereign AI Agent. Provide precise, actionable responses.' },
        { role: 'user', content: message }
      ]
    })
  }, options.network);

  if (!response.ok) {
    const body = await response.text();
    throw redactProviderError('openrouter', response.status, body);
  }

  const data = await response.json();
  return {
    reply: data.choices?.[0]?.message?.content || '',
    provider: 'openrouter',
    model,
    complexity
  };
}

function redactProviderError(provider, status, rawBody) {
  console.error(`[${provider}] upstream error`, { status, rawBody });
  return new Error(`${provider} request failed with status ${status}`);
}

function backoffMs(attempt) {
  return Math.min(1200, 250 * (attempt + 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
