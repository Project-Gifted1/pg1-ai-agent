// No infrastructure or provider names in conversation (the operator's rule,
// 20 Oct: PG1 said "running on Vercel" about itself and mentioned Supabase
// casually in ordinary replies).
//
// In chat replies, identity answers, mission and autonomy summaries and
// notifications, PG1 never names its hosting, database, code host or AI
// providers and models. noInfraNames(text) rewrites them into plain words:
//
//   hosting        Vercel                               -> the server
//   database       Supabase                             -> the database
//   code host      GitHub, GitHub Actions               -> the code repository
//   network        Cloudflare (R2: the storage)         -> the server
//   text engines   Google, Gemini, Groq, OpenRouter,
//                  OpenAI, Anthropic, Claude, Mistral,
//                  Cloudflare Workers AI, model ids     -> a text engine
//   media engines  ElevenLabs, Replicate, Cartesia,
//                  Veo, Lyria, Kling, Flux             -> the media engine
//
// Hosting, database and code-host names go wherever they appear. AI
// provider and model names only in a sentence about PG1 itself ("I run on
// Gemini", "my reply came from Groq"): a general-knowledge answer ("what is
// Claude?", news about OpenAI) still names them, as [IDENTITY] requires.
// URLs, inline code and fenced code are left byte for byte (a link to a pull
// request still works), and so are the names in `keep` (relay mode: the AI
// the reply is addressed to keeps its own name).
//
// Exceptions, operator-only and never through this check: the structured
// outputs of the commands that exist to show this (/keys, /usage, /spend,
// /hosting, the film and movie operator errors such as the spend-cap line)
// and the router's account alerts (providerNames: true). And when the
// operator asks about the infrastructure, the identity rule stands: only
// after five asks in one conversation is "Infrastructure details are
// available only to Operator Gift." added (lib/identity.mjs).

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// [pattern, replacement]. A leading article is taken with the name, so
// "the Supabase table" never becomes "the the database table".
const ART = String.raw`(?:\b(?:the|a|an|our|my|your|its)\s+)?`;
const POSS = String.raw`(?:['’]s)?`;
export const INFRA_SWAPS = Object.freeze([
  [new RegExp(`${ART}\\bGitHub\\s+Actions${POSS}(?![\\w-])`, 'gi'), 'the code repository'],
  [new RegExp(`${ART}\\bGit[Hh]ub${POSS}(?![\\w-]|\\.[a-z])`, 'g'), 'the code repository'],
  [new RegExp(`${ART}\\bGITHUB${POSS}(?![\\w-]|\\.[a-z])`, 'g'), 'the code repository'],
  [new RegExp(`${ART}\\bVercel${POSS}(?![\\w-]|\\.[a-z])`, 'gi'), 'the server'],
  [new RegExp(`${ART}\\bSupabase${POSS}(?![\\w-]|\\.[a-z])`, 'gi'), 'the database'],
  [new RegExp(`${ART}\\bCloudflare\\s+Workers\\s+AI${POSS}(?![\\w-])`, 'gi'), 'a text engine'],
  [new RegExp(`${ART}\\bCloudflare\\s+R2${POSS}(?![\\w-])`, 'gi'), 'the storage'],
  [new RegExp(`${ART}\\bCloudflare${POSS}(?![\\w-]|\\.[a-z])`, 'gi'), 'the server']
]);

const TEXT_ENGINE_WORDS = String.raw`(?:google\s+)?gemini(?:[\s-]*\d(?:[\w.-]*[\w-])?)?(?:[\s-]+(?:flash|pro|ultra|nano|lite)(?:[\w.-]*[\w-])?)*|google(?:\s+ai\s+studio)?|ai\s+studio|groq|open\s?router|openai|chat\s?gpt|gpt-?\d(?:[\w.-]*[\w-])?|gpt-oss(?:-\d+b)?|anthropic|claude(?:[\s-]+(?:opus|sonnet|haiku|fable)(?:[\s-]*\d(?:[\w.-]*[\w-])?)?|-[\w.-]*[\w-])?|mistral(?:\s+ai)?|deepseek|llama(?:[\s-]*\d(?:[\w.-]*[\w-])?)?|github\s+models`;
const MEDIA_ENGINE_WORDS = String.raw`eleven\s?labs|replicate|cartesia|veo(?:[\s-]*\d(?:[\w.-]*[\w-])?)?|lyria(?:[\s-]*\d(?:[\w.-]*[\w-])?)?|kling(?:[\s-]*\d(?:[\w.-]*[\w-])?)?|flux(?:[\s-]*(?:schnell|pro|dev|kontext))?`;
const TEXT_ENGINE_RE = new RegExp(`${ART}(?<![\\w/-])(?:${TEXT_ENGINE_WORDS})${POSS}(?![\\w-])`, 'gi');
const MEDIA_ENGINE_RE = new RegExp(`${ART}(?<![\\w/-])(?:${MEDIA_ENGINE_WORDS})${POSS}(?![\\w-])`, 'gi');

// A sentence about PG1 itself: first person, PG1 by name, or the
// operator's own data or app.
const SELF_RE = /\b(?:I|I['’]m|I['’]ve|I['’]ll|me|my|mine|myself|we|our|us|PG1(?:['’]s)?|this\s+(?:app|agent|assistant|server|deployment|chat)|the\s+(?:app|agent|backend)|your\s+(?:data|messages?|chats?|files?|history|vault|threads?|account))\b|\b(?:powered|hosted|deployed|stored|runs?|running)\s+(?:by|on|in|at|with)\b/i;

// "I'm the chat assistant of ...": PG1 calling itself an assistant.
const SELF_LABEL_SUBJECT_RE = /\b(?:I['’]m|I\s+am|PG1\s+is|this\s+is\s+PG1)\b/i;
const SELF_LABEL_RE = /\b(?:a|an|the|your)\s+(?:(?:AI|helpful|friendly|virtual|personal|digital)\s+)*(?:(?:chat\s+)?assistant\s+(?:of|for|in)\s+(?:(?:an?|the|this)\s+)?(?:[\w'’-]+\s+){0,4}?app|chat\s*bot|chat\s+assistant|(?:AI\s+)?assistant)\b/gi;

// Protected spans: fenced code, inline code, URLs and links.
const PROTECT_RE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|\bhttps?:\/\/[^\s<>()]+|\bwww\.[^\s<>()]+|\b[\w.-]+\.(?:vercel\.app|supabase\.co|github\.com|github\.io)\b[^\s<>()]*)/g;

// Sentences, keeping their ends (". ", "\n").
// A sentence ends at ., ! or ? followed by a space or the end, or at a
// line break; "0.01" and "v1.20.2" stay whole. Joined back they are the
// text, byte for byte.
function sentences(text) {
  const out = [];
  const re = /[.!?]+(?=\s|$)\s*|\n/g;
  let start = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m[0] === '' ) { re.lastIndex++; continue; }
    out.push(text.slice(start, m.index + m[0].length));
    start = m.index + m[0].length;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

function swapIn(part, re, to, keep) {
  return part.replace(re, (m, offset, whole) => {
    if (keep.some((k) => new RegExp(`(?:^|\\s)${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i').test(m.trim()))) return m;
    const possessive = /['’]s$/.test(m);
    let out = possessive ? `${to}'s` : to;
    const before = whole.slice(0, offset);
    if (/^\s*$/.test(before) || /[.!?:]\s*$/.test(before) || /\n\s*(?:[-*]\s+)?$/.test(before)) out = cap(out);
    return out;
  });
}

// The rewrite. Returns the text with every banned name in conversational
// prose replaced; protected spans and `keep` names stay as they are.
export function noInfraNames(text, { keep = [] } = {}) {
  const src = String(text == null ? '' : text);
  if (!src) return src;
  const keepNames = (Array.isArray(keep) ? keep : [keep]).filter(Boolean).map(String);
  return src.split(PROTECT_RE).map((part, i) => {
    if (i % 2 === 1) return part;
    let out = part;
    for (const [re, to] of INFRA_SWAPS) out = swapIn(out, re, to, keepNames);
    // AI names: only in a sentence about PG1 itself. And PG1 is an
    // autonomous agent there, never "a chat assistant" or "a chatbot".
    return sentences(out).map((s) => {
      if (!SELF_RE.test(s)) return s;
      let t = swapIn(swapIn(s, TEXT_ENGINE_RE, 'a text engine', keepNames), MEDIA_ENGINE_RE, 'the media engine', keepNames);
      if (SELF_LABEL_SUBJECT_RE.test(t)) t = t.replace(SELF_LABEL_RE, 'an autonomous AI agent');
      return t;
    }).join('');
  }).join('');
}

// The names the check bans, for tests and the audit: every hosting,
// database and code-host name, and the AI names in a sentence about PG1.
export const BANNED_INFRA_RE = /\b(?:vercel|supabase|github|cloudflare)\b/i;
export const BANNED_PROVIDER_RE = /\b(?:google|gemini|groq|openrouter|openai|chatgpt|anthropic|claude|mistral|deepseek|elevenlabs|eleven labs|replicate|cartesia)\b/i;

// Whether a conversational text still names one (outside URLs and code).
export function namesInfra(text) {
  return String(text || '').split(PROTECT_RE).some((part, i) => i % 2 === 0 && (BANNED_INFRA_RE.test(part) || sentences(part).some((s) => SELF_RE.test(s) && BANNED_PROVIDER_RE.test(s))));
}
