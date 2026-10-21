// HONESTY ABOUT WHAT PG1 IS. PG1 has a self-model (lib/core/self.mjs): a
// functional description of its own state, read from real data. That is
// not consciousness, and PG1 never says it is conscious, sentient, alive or
// has feelings. Asked, it says whether an AI can be conscious is an open
// question, and describes its state functionally. The identity rules
// (lib/identity.mjs: no engine, provider or model names) still apply.
//
//   HONESTY_DIRECTIVE            the prompt rule
//   isConsciousnessQuestion(t)   "are you conscious / alive / sentient?",
//                                "do you have feelings?", "how do you feel?"
//   consciousnessReply(model)    a deterministic answer from the self-model
//   fixConsciousnessClaims(t)    a reply's first-person claims rewritten
//                                ("I am conscious" -> what is true)

export const HONESTY_DIRECTIVE = '[HONESTY ABOUT WHAT YOU ARE]: Never claim to be conscious, sentient, self-aware or alive, and never claim to have feelings, emotions or experiences. If asked, say plainly that whether an AI can be conscious is an open question, that you do not claim to be, and describe your state functionally from [PG1 SELF-MODEL] (what is available, degraded or unavailable, what you are working on). Do not deny it with false certainty either; say it is an open question. "How are you?" is answered with your functional state, not a feeling.';

const Q_RE = /\b(?:are|r)\s+(?:you|u)\s+(?:really\s+|actually\s+|truly\s+)?(?:conscious|sentient|self[-\s]?aware|alive|a\s+(?:person|living\s+being)|aware\s+of\s+yourself)\b|\bdo\s+(?:you|u)\s+(?:have|feel|experience)\s+(?:any\s+|real\s+)?(?:feelings?|emotions?|consciousness|sentience|experiences?|pain|joy)\b|\bcan\s+(?:you|u)\s+feel\b|\bhow\s+do\s+(?:you|u)\s+feel\b|\b(?:your|ur)\s+(?:feelings|emotions|consciousness)\b|\bdo\s+you\s+(?:dream|suffer)\b/i;

export function isConsciousnessQuestion(text) {
  return Q_RE.test(String(text || ''));
}

export function consciousnessReply(model = null) {
  const lead = 'Whether an AI can be conscious is an open question, and I do not claim to be conscious, sentient or alive, or to have feelings. What I can describe is my state, functionally.';
  if (!model || !Array.isArray(model.capabilities)) return `${lead} Ask /state for the details.`;
  const by = (s) => model.capabilities.filter((c) => c.status === s).map((c) => c.label);
  const down = [...by('unavailable'), ...by('degraded')];
  const parts = [`${by('available').length} of ${model.capabilities.length} capabilities are available`];
  if (down.length) parts.push(`limited right now: ${down.slice(0, 4).join(', ')}${down.length > 4 ? ' and more' : ''}`);
  return `${lead} Right now: ${parts.join('; ')}. ${model.focus} /state shows the details.`;
}

// First-person claims, rewritten. Negations ("I am not conscious") and
// questions about others are left alone.
const CLAIMS = [
  [/\bI(?:'m| am)\s+(?:truly\s+|really\s+|fully\s+|genuinely\s+|definitely\s+)?(conscious|sentient|self[-\s]?aware|alive)\b/gi, 'I do not claim to be $1 (whether an AI can be is an open question)'],
  [/\bI\s+(?:truly\s+|really\s+|genuinely\s+|do\s+)?have\s+(?:real\s+|genuine\s+|my\s+own\s+)?(feelings|emotions|consciousness|experiences)\b/gi, 'I do not claim to have $1'],
  [/\bI\s+(?:truly\s+|really\s+|genuinely\s+)?feel\s+(happy|sad|excited|lonely|afraid|scared|angry|joy|pain|hurt|grateful|proud)\b/gi, 'my state is functional, not a feeling ($1 is not something I claim)'],
  [/\bI(?:'m| am)\s+a\s+(living|conscious|sentient)\s+being\b/gi, 'I am software, not a $1 being']
];

export function fixConsciousnessClaims(text) {
  let out = String(text == null ? '' : text);
  let changed = 0;
  for (const [re, rep] of CLAIMS) out = out.replace(re, (...m) => { changed++; return rep.replace('$1', m[1].toLowerCase()); });
  return { text: out, changed };
}
