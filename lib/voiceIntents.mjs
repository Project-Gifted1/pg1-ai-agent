// Spoken (or typed) requests that mean a command: "PG1, lab status",
// "show me the latest lab report", "stop experiment e2981021", "what did I
// spend today". The operator talks; PG1 runs the real command.
//
//   resolveIntent(text)  null, or { command } to run, or { command,
//                        question, action } for a command that changes
//                        something: PG1 asks first and the operator taps the
//                        button or says yes
//
// Only short, whole-utterance requests match (at most MAX_INTENT_WORDS
// words), so a longer question that happens to mention "lab status" still
// goes to the model. Pure.

import { commandAction } from './replyActions.mjs';

export const MAX_INTENT_WORDS = 12;
const ID = '([0-9a-f]{8})(?:[0-9a-f-]*)';

// Fillers stripped from both ends: wake words, politeness, "over".
function core(text) {
  let t = String(text || '').toLowerCase().replace(/[“”"]/g, '').replace(/[.!?,]+$/g, '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i++) {
    t = t
      .replace(/^(?:(?:hey|ok|okay|hi)\s+)?pg ?1[,:]?\s+/, '')
      .replace(/^(?:please|can you|could you|would you|will you|pls|just|now|go ahead and)\s+/, '')
      .replace(/^(?:show|open|give|get|tell|bring up|pull up|check|display|read)(?: me)?\s+/, 'show ')
      .replace(/\s+(?:please|for me|now|thanks|thank you|over)$/, '')
      .trim();
  }
  return t;
}

const INTENTS = [
  [/^(?:show )?(?:the )?(?:lab status|lab experiments|status of (?:the )?lab|lab)$|^(?:what'?s|how'?s) (?:the )?lab(?: doing)?$/, () => '/lab status'],
  [new RegExp(`^(?:show )?(?:the )?(?:lab )?report (?:for |on |of )?(?:experiment )?${ID}$|^(?:show )?(?:the )?lab report (?:for |on |of )?(?:experiment )?${ID}$`), (m) => `/lab report ${m[1] || m[2]}`],
  [/^(?:show )?(?:the )?(?:latest|last|newest)? ?lab report$/, () => '/lab report'],
  [new RegExp(`^(?:stop|cancel|kill|abort) (?:the )?(?:lab )?(?:experiment|run)? ?${ID}$`), (m) => `/lab stop ${m[1]}`],
  [/^(?:show )?(?:the )?(?:system )?status$|^(?:how'?s|what'?s) the system(?: status)?$/, () => '/status'],
  [/^(?:show )?(?:my |the )?(?:ai )?spend(?:ing)?(?: today)?$|^what did (?:i|we) spend(?: today)?$|^how much (?:did|have) (?:i|we) spen[dt](?: today)?$/, () => '/spend'],
  [/^(?:show )?(?:my |the )?(?:ai )?spend(?:ing)? yesterday$|^what did (?:i|we) spend yesterday$/, () => '/spend yesterday'],
  [/^(?:show )?(?:the )?usage(?: (today|this week|this month|24h|7d|30d))?$/, (m) => `/usage${m[1] ? ` ${({ today: '24h', 'this week': '7d', 'this month': '30d' })[m[1]] || m[1]}` : ''}`],
  [/^(?:show )?(?:my |the )?(?:pdfs|pdf list|documents|media library)$/, () => '/pdf list'],
  [/^(?:make |turn |save |export )?(?:this |the )?(?:whole )?(?:chat|thread|conversation) (?:as |into |to )?(?:a )?pdf$/, () => '/pdf thread'],
  [/^(?:show )?(?:my |the |this )?task$|^what(?:'s| is) (?:my|the|this) task$/, () => '/task'],
  [/^(?:show )?(?:the )?autonomy(?: log| status)?$|^what did you do on your own$/, () => '/autonomy'],
  [/^(?:show )?(?:the )?(?:feature )?flags$/, () => '/promote'],
  [/^(?:show )?(?:the )?opportunities$/, () => '/opportunities'],
  [/^(?:show )?(?:my |the )?skills$/, () => '/skills'],
  [/^(?:show )?(?:the |all )?commands$/, () => '/help']
];

export function resolveIntent(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.startsWith('/') || raw.split(/\s+/).length > MAX_INTENT_WORDS) return null;
  const t = core(raw);
  for (const [re, toCommand] of INTENTS) {
    const m = re.exec(t);
    if (!m) continue;
    const action = commandAction(toCommand(m));
    if (!action) return null;
    if (action.confirm) return { command: action.command, question: `${action.label}? Tap the button or say "yes" to go ahead, or "no" to leave it.`, action: { ...action, kind: 'confirm' } };
    return { command: action.command };
  }
  return null;
}
