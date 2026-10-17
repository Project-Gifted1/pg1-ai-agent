// Fits one text request to an engine's input limit before the call, instead
// of sending it and failing (request sjv9vnbs: a ~10,400-token heavy chat
// was refused by Groq's free tier at 8,000 tokens and answered with nothing
// by GitHub Models' free tier, which takes 8,000 input tokens per request).
//
// What goes, in order, until the request fits:
//   1. memory, oldest first: the [EARLIER IN THIS THREAD] summary, then the
//      OPERATOR:/AGENT: lines of the conversation in [CONTEXT], one at a
//      time from the oldest
//   2. tool output: the stored-context blocks ([LIVE THREAT TELEMETRY],
//      [SUPABASE VAULT ...], [UNRESOLVED ERRORS]) and a checks transcript
//      ([CHECKS ALREADY RUN]), largest first
//   3. the reference text: each [CAPABILITIES] bullet cut to its first
//      sentence (the directives and the operator's message are never cut)
// If it still does not fit, the engine is skipped (fits: false) and the
// round moves on: the operator's message itself is never shortened.
//
// Tokens are estimated at 4 characters each with a 10% margin, since the
// engines' tokenisers differ (Cloudflare counted 9,885 for a request PG1
// estimated at 10,368).

export const FIT_MARGIN = 0.9;
export const tokensOf = (text) => Math.ceil(String(text || '').length / 4);

const CONTEXT_MARK = '[CONTEXT]:';
const SUMMARY_RE = /\[EARLIER IN THIS THREAD\][^\n]*\n[\s\S]*?(?=\n\n\[|\n\n(?:OPERATOR|AGENT):|$)/;
const TOOL_BLOCK_RE = /\n*\[(?:LIVE THREAT TELEMETRY|TODAY'S THREAT FEED|LATEST THREAT FEED|SUPABASE VAULT|UNRESOLVED ERRORS|CHECKS ALREADY RUN)[^\]]*\][\s\S]*?(?=\n\n\[|$)/g;

function dropOldestTurn(text) {
  const at = text.indexOf(CONTEXT_MARK);
  const scope = at >= 0 ? at : 0;
  const re = /^(?:OPERATOR|AGENT): .*(?:\n(?!(?:OPERATOR|AGENT): |\[|\n).*)*\n?/m;
  const tail = text.slice(scope);
  const m = re.exec(tail);
  if (!m) return null;
  return text.slice(0, scope) + tail.slice(0, m.index) + tail.slice(m.index + m[0].length);
}

function dropSummary(text) {
  const m = SUMMARY_RE.exec(text);
  return m ? text.slice(0, m.index) + text.slice(m.index + m[0].length) : null;
}

function dropLargestToolBlock(text) {
  const blocks = [...text.matchAll(TOOL_BLOCK_RE)];
  if (!blocks.length) return null;
  const big = blocks.reduce((a, b) => (b[0].length > a[0].length ? b : a));
  return text.slice(0, big.index) + text.slice(big.index + big[0].length);
}

function shortenCapabilities(text) {
  const start = text.indexOf('[CAPABILITIES');
  if (start < 0) return null;
  const end = text.indexOf('\n\n', start);
  const block = text.slice(start, end < 0 ? text.length : end);
  const short = block.split('\n').map((line) => {
    if (!/^- /.test(line) || line.length < 240) return line;
    const m = /^(- [\s\S]{40,400}?[.!?])(?:\s|$)/.exec(line);
    return m ? m[1] : line.slice(0, 240);
  }).join('\n');
  return short.length < block.length ? text.slice(0, start) + short + text.slice(start + block.length) : null;
}

// { system, prompt, fits, inputTokens, trimmed: ['memory', 'tool_output', 'reference'] }
// maxInputTokens: the engine's limit for input (and, for an engine that
// counts the reply into the same budget, minus the reply's max tokens).
export function fitRequest({ system = '', prompt = '', maxInputTokens = Infinity } = {}) {
  const budget = Number.isFinite(maxInputTokens) ? Math.floor(maxInputTokens * FIT_MARGIN) : Infinity;
  let sys = String(system || '');
  const msg = String(prompt || '');
  const size = () => tokensOf(sys) + tokensOf(msg);
  const trimmed = [];
  const step = (kind, fn) => {
    while (size() > budget) {
      const next = fn(sys);
      if (next == null || next.length >= sys.length) return;
      sys = next;
      if (!trimmed.includes(kind)) trimmed.push(kind);
    }
  };
  step('memory', (t) => dropSummary(t) ?? dropOldestTurn(t));
  step('tool_output', dropLargestToolBlock);
  step('reference', shortenCapabilities);
  return { system: sys, prompt: msg, fits: size() <= budget, inputTokens: size(), trimmed };
}
