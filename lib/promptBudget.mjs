// What one chat turn's prompt needs, so a light chat stops sending 10-13k
// input tokens (production, 19-20 Oct: input_tokens 13281 for task=light on
// the free Gemini key; a "hello" carried ~9,700 tokens of system prompt
// before any history, and a tools-route turn ~5,000 more of function
// schemas).
//
//   turnNeeds(text, opts)  which parts of the prompt this turn needs:
//     smallTalk   a greeting or thanks: the compact prompt (target < 3,000
//                 input tokens)
//     identity    who/what PG1 is, models, providers, keys, voice, images:
//                 the full identity rules (else the compact ones)
//     commands    a slash command or a feature by name: the full
//                 description of what each command does
//     voice, attachments, code, checks, offers, pdf, relay, errors, vault
//                 the matching [CAPABILITIES] lines and context blocks
//   slimCapabilities(prompt, needs)  drops the [CAPABILITIES] lines this
//     turn does not need and leaves one line saying what was left out
//   toolsForRoute(tools, route, text)  the function schemas the tools route
//     needs (a wallet: the wallet checks; a hostname: the domain checks),
//     not all of them
//   RECENT_TURNS_SMALL_TALK  how many recent messages small talk keeps
//
// Normal operator chat targets < 6,000 input tokens. The chat logs
// "[chat] prompt route=.. tier=.. input_tokens~.." for every turn.

export const SMALL_TALK_MAX_CHARS = 80;
export const RECENT_TURNS_SMALL_TALK = 4;

const SMALL_TALK_RE = /^\s*(?:(?:hi|hey|hello|hiya|yo|sup|heya|howdy|morning|evening|thanks|thank\s+you|thx|ty|cheers|ok(?:ay)?|cool|great|nice|perfect|awesome|lol|haha|good\s+(?:morning|afternoon|evening|night)|bye|goodbye|see\s+you|night|gn|how\s+are\s+you|how'?s\s+it\s+going|how\s+is\s+it\s+going|what'?s\s+up|you\s+there|are\s+you\s+there)(?:\s+(?:pg1|there|mate|buddy|again|so\s+much|a\s+lot|today|doing|all))*)[\s,.!?:)]*(?:(?:how\s+are\s+you|how'?s\s+it\s+going|thanks|thank\s+you)[\s,.!?]*)?$/i;
const FEATURES_RE = /what\s+can\s+you\s+do|capabilit|feature|how\s+(?:do|does|can|should)\s+(?:i|you|it|we)|\bhelp\b|menu|button|setting|switch|toggle|\bicons?\b|\btrace\b|\bsteps?\b|drawer|hand-?off|camera/i;
const COMMANDS_RE = /\/[a-z]|\bcommands?\b|\bstatus\b|radar|commerce|\bvault\b|\busage\b|\bspend\b|\bkeys?\b|\blab\b|\bfilm|\bmovie|\bmusic|\bvideo|\bimage|\bpdf\b|mission|autonom|\bauto\b|\bwatch|\bskills?\b|foundry|hosting|screening|watchlist|opportunit|\ba2a\b|\brelay\b|\btask\b|\bpin\b|\bexport\b|\bcore\b|\bapprov|\bdecline\b/i;
const IDENTITY_RE = /\b(?:who|what)\s+(?:are|r)\s+(?:you|u)\b|your\s+name|\bmodels?\b|\bllm\b|\bai\b|\bengine|powered|built\s+(?:on|by|with)|provider|\bversion\b|gemini|claude|\bgpt|openai|chatgpt|google|anthropic|groq|mistral|deepseek|llama|openrouter|proprietary|own\s+model|api\s+keys?|\bsecrets?\b|\btokens?\b|\benv\b|\bvoice|\btts\b|speech|image|video|vercel|supabase|github|cloudflare|elevenlabs|cartesia|replicate|infrastructure|hosted|database/i;
const VOICE_RE = /voice|speak|spoken|read\s+aloud|\btts\b|audio|listen|waveform|\bmic\b|conversation\s+mode/i;
const ATTACH_RE = /image|photo|screenshot|attach|paperclip|picture|\bfile|upload/i;
const CODE_RE = /\bcode\b|patch|\bpr\b|pull\s+request|commit|\brepo|branch|\bbug|\bfix|deploy|function|\btests?\b|\bjs\b|javascript|python|\bapi\b/i;
const CHECKS_RE = /check|wallet|domain|hostname|\burl\b|\bip\b|\bcve\b|hash|\bioc\b|indicator|package|\bnpm\b|pypi|sanction|fixture|threat|preflight|\bens\b|\.eth\b|actor|malicious|flagged/i;
const OFFERS_RE = /price|pricing|package|quote|proposal|\boffer|client|cost|deliver|invoice|\bplan\b|tier/i;
const PDF_RE = /\bpdf\b|document|report|print/i;
const ERRORS_RE = /error|broken|fail|\bbug|issue|wrong|\bdown\b|status|crash|not\s+working|went\s+wrong/i;
const VAULT_RE = /vault|\bfiles?\b|storage|upload|bucket/i;

export function isSmallTalk(text) {
  const t = String(text || '').trim();
  return !!t && t.length <= SMALL_TALK_MAX_CHARS && !t.startsWith('/') && SMALL_TALK_RE.test(t);
}

export function turnNeeds(text, { imageCount = 0, relay = false, offer = false, keyQuestion = null, route = null } = {}) {
  const t = String(text || '');
  const smallTalk = !relay && !imageCount && isSmallTalk(t);
  if (smallTalk) {
    return { smallTalk: true, identity: false, commands: false, features: false, voice: false, attachments: false, code: false, checks: false, offers: false, pdf: false, relay: false, errors: false, vault: false };
  }
  const features = FEATURES_RE.test(t);
  return {
    smallTalk: false,
    features,
    identity: !!keyQuestion || IDENTITY_RE.test(t),
    commands: features || COMMANDS_RE.test(t),
    voice: features || VOICE_RE.test(t),
    attachments: features || imageCount > 0 || ATTACH_RE.test(t),
    code: features || CODE_RE.test(t),
    checks: features || route === 'tools' || CHECKS_RE.test(t),
    offers: !!offer || OFFERS_RE.test(t),
    pdf: PDF_RE.test(t),
    relay: !!relay || /\brelay/i.test(t),
    errors: ERRORS_RE.test(t),
    vault: VAULT_RE.test(t)
  };
}

// [CAPABILITIES] lines by what they describe: [prefix, need].
export const CAPABILITY_LINES = Object.freeze([
  ['- Slash commands and what they really do', 'commands'],
  ['- Code changes arrive as JSON actions', 'code'],
  ['- Voice: the "Spoken replies" switch', 'voice'],
  ['- Send to Code:', 'code'],
  ['- Live trace:', 'features'],
  ['- Message actions:', 'features'],
  ['- Attachments and image understanding', 'attachments'],
  ['- Public services PG1 runs', 'checks'],
  ['- Checks from chat:', 'checks'],
  ['- Environment awareness:', 'features'],
  ['- If asked what\'s broken:', 'errors'],
  ['- The ➕ menu has an ERROR LOG', 'errors'],
  ['- Every MCP tool call and A2A skill response', 'checks'],
  ['- check_wallet_age reports age per chain', 'checks'],
  ['- Integration test fixtures:', 'checks']
]);
export const LEFT_OUT_LINE = '- Not described in this turn (the operator did not ask about them): the slash commands in detail, voice, attachments, code changes, the checks you can run, the live trace and message actions. If the operator asks about one, say what you know from [COMMAND FORMS] and [IDENTITY], and that the details are one question away; never invent a feature. /export and /vault show the recent chat archive, the same last few messages already in [CONTEXT] and nothing older.';

export function slimCapabilities(prompt, needs) {
  if (!needs) return prompt;
  let dropped = 0;
  const out = String(prompt).split('\n').filter((line) => {
    const hit = CAPABILITY_LINES.find(([prefix]) => line.startsWith(prefix));
    if (!hit || needs[hit[1]]) return true;
    dropped++;
    return false;
  });
  if (!dropped) return prompt;
  // The note goes where the last capability line was, before "Your own internals".
  const at = out.findIndex((l) => l.startsWith('- Your own internals:'));
  if (at >= 0) out.splice(at, 0, LEFT_OUT_LINE);
  else out.push(LEFT_OUT_LINE);
  return out.join('\n');
}

// The function schemas a tools-route turn needs.
const TOOL_WORDS = Object.freeze([
  [/wallet|0x[0-9a-f]{6,}|\.eth\b|\bens\b|sanction|address/i, ['check_wallet_sanctions', 'check_wallet_age']],
  [/domain|hostname|\burl\b|https?:|www\.|\.[a-z]{2,}\b|phish|site/i, ['check_domain_age', 'check_hostname_reputation', 'get_ioc_context']],
  [/\bip\b|\d+\.\d+\.\d+\.\d+|indicator|\bioc\b|hash/i, ['get_ioc_context', 'get_ioc_batch']],
  [/\bcve\b|vulnerab|exploit|\bkev\b/i, ['get_cve_details', 'get_cve_batch', 'get_cve_by_product']],
  [/package|\bnpm\b|pypi|install|dependency|library/i, ['check_package']],
  [/actor|apt\d*|group|campaign/i, ['get_threat_actor_profile']]
]);
const REASON_TOOLS = Object.freeze({
  wallet_address: ['check_wallet_sanctions', 'check_wallet_age'],
  ens_name: ['check_wallet_sanctions', 'check_wallet_age'],
  hostname: ['check_domain_age', 'check_hostname_reputation', 'get_ioc_context'],
  url: ['check_domain_age', 'check_hostname_reputation', 'get_ioc_context'],
  ip_address: ['get_ioc_context', 'get_ioc_batch'],
  check_request: ['get_cve_details', 'get_cve_batch', 'get_ioc_context', 'get_ioc_batch'],
  usage_stats: ['get_usage_stats'],
  history: ['search_history'],
  video: ['generate_video']
});

export function toolsForRoute(tools, route, text) {
  const list = Array.isArray(tools) ? tools : [];
  const reason = route && route.reason;
  // A named check, a skill or anything else: every tool, as before.
  if (!reason || !REASON_TOOLS[reason]) return list;
  const want = new Set(REASON_TOOLS[reason]);
  const t = String(text || '');
  if (reason !== 'history' && reason !== 'video' && reason !== 'usage_stats') {
    for (const [re, names] of TOOL_WORDS) if (re.test(t)) names.forEach((n) => want.add(n));
  }
  const out = list.filter((x) => want.has(x.name));
  return out.length ? out : list;
}
