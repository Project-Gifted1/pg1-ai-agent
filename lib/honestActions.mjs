// Honest actions: a model reply may never say PG1 started, stopped,
// watched or changed something unless that action really ran in this turn.
//
// A model reply runs no lab, watch, deploy or code action: those only run
// through commands (/lab start, /watch, the approval cards) and the chat
// tools, whose outcomes the caller passes in `ran`. So a sentence in a
// model reply that claims one of them, with no matching outcome, is false.
//
//   findFalseClaims(text, { ran })   [{ kind, sentence }]
//   honestReply(text, { ran, prompt, isOperator })
//       { text, note, actions, claims }
//       text     the reply with each false claim replaced by what is true
//                (for a reply not yet shown: the JSON path)
//       note     the same correction as one paragraph to append (for a
//                streamed reply the operator has already seen)
//       actions  for a false "starting the experiment": a real, operator-
//                confirmed Start experiment button (/lab start <goal>);
//                pressing it runs /lab start, so the autonomy policy, the
//                lab budgets and the kill switch all apply
//
// Kinds: start (an experiment, run, build or deploy), stop, watch (watch,
// monitor, "I'll let you know when"), change (deployed, merged, pushed,
// updated a setting, opened a PR). Questions, offers ("I can start it",
// "shall I") and instructions ("send /lab start ...") are not claims. Pure.

import { commandAction } from './replyActions.mjs';
import { classifyLabKind } from './lab/policy.mjs';

export const HONEST_ACTIONS_DIRECTIVE = 'Honest actions: in a reply you cannot start, stop, cancel, watch, monitor, deploy, merge, push or change anything; only commands and their buttons do. Never write that you are starting, have started, stopped, are watching or monitoring, will let the operator know, or have changed, deployed or merged something. Say what the operator can send instead: `/lab start <goal>` to start a lab experiment, `/lab stop <id>` to stop one, "watch it" or `/watch` to be told when something finishes.';

const SUBJECT = String.raw`(?:i|we|pg1)`;
const FIRST = String.raw`(?:^|[\s(“"'])(?:${SUBJECT}(?:'m|’m| am|'ve|’ve| have|'ll|’ll| will| are|'re|’re| just| now| already|\s)*\s*|(?:now|ok(?:ay)?|alright|sure|done|great|got it)[,:!.]?\s+|^)`;

const KINDS = [
  {
    kind: 'start',
    re: new RegExp(String.raw`${FIRST}(?:start(?:ing|ed)?|launch(?:ing|ed)?|kick(?:ing|ed)?\s+off|dispatch(?:ing|ed)|queu(?:e|ing|ed)|spinning\s+up|spun\s+up|trigger(?:ing|ed)|running|ran|beginning|began)\b[^.!?\n]{0,60}?\b(?:experiments?|lab|runs?|workflows?|builds?|deploy(?:ment)?s?|research\s+run|job)\b`, 'i')
  },
  {
    kind: 'stop',
    re: new RegExp(String.raw`${FIRST}(?:stop(?:ping|ped)?|cancel(?:l?ing|l?ed)?|halt(?:ing|ed)?|kill(?:ing|ed)?|abort(?:ing|ed)?|shut(?:ting)?\s+down)\b[^.!?\n]{0,60}?\b(?:experiments?|lab|runs?|workflows?|builds?|deploy(?:ment)?s?|jobs?|watch(?:es)?)\b`, 'i')
  },
  {
    kind: 'watch',
    re: new RegExp(String.raw`(?:${FIRST}(?:watching|monitoring|tracking|keeping\s+(?:an\s+)?eye|keep\s+(?:an\s+)?eye|watch|monitor|track)\b|\b${SUBJECT}(?:'ll|’ll| will| shall)\s+(?:let\s+you\s+know|notify\s+you|ping\s+you|tell\s+you|alert\s+you|report\s+back|get\s+back\s+to\s+you|update\s+you)\s+(?:here\s+)?(?:when|once|as\s+soon\s+as|the\s+moment|if\s+(?:it|the|anything)|after)\b|\b(?:set\s+up|created|added)\s+(?:a\s+)?(?:watch|monitor|alert)\b)`, 'i')
  },
  {
    kind: 'change',
    re: new RegExp(String.raw`${FIRST}(?:deployed|merged|pushed|committed|updated|changed|modified|enabled|disabled|switched\s+(?:on|off)|turned\s+(?:on|off)|raised|lowered|set|configured|opened|created|rolled\s+back|promoted)\b[^.!?\n]{0,60}?\b(?:deploy(?:ment)?|production|prs?|pull\s+requests?|branch(?:es)?|code|repo(?:sitory)?|config(?:uration)?|settings?|env(?:ironment)?(?:\s+var(?:iable)?s?)?|flags?|skills?|budgets?|database|tables?|webhooks?|polic(?:y|ies)|autonomy|kill\s+switch)\b`, 'i')
  }
];

// Not a claim: a question, an offer, a conditional, an instruction or a
// denial.
const NOT_A_CLAIM = /\?|\b(?:you\s+can|you\s+could|you'?ll\s+need|to\s+(?:start|stop|watch|run|deploy)|send\s|tap\s|say\s|type\s|use\s+[`/]|if\s+you|would\s+you|shall\s+i|should\s+i|do\s+you\s+want|want\s+me\s+to|i\s+can(?:not|'t)?\s|i\s+could|i'?d\s|i\s+would|i\s+(?:have\s+not|haven'?t|did\s+not|didn'?t|am\s+not|'m\s+not|won'?t|cannot|can'?t)|not\s+(?:started|stopped|watching|changed|deployed|merged)|nothing\s+(?:was|has\s+been|is)|once\s+you|when\s+you|after\s+you|until\s+you|earlier|previously|yesterday|last\s+(?:time|week|night)|ago)\b/i;

// The tool / command outcome kinds that make a claim of that kind true.
export function ranKinds(outcomes = []) {
  const kinds = new Set();
  for (const o of Array.isArray(outcomes) ? outcomes : []) {
    const name = String((o && (o.tool || o.name)) || '');
    if (/generate_video/.test(name) && o.ok !== false) kinds.add('start');
  }
  return kinds;
}

function sentences(text) {
  return String(text || '').match(/[^.!?\n]+(?:[.!?]+|\n|$)/g) || [];
}

export function findFalseClaims(text, { ran = new Set() } = {}) {
  const out = [];
  for (const s of sentences(text)) {
    const t = s.trim();
    if (!t || NOT_A_CLAIM.test(t) || /`\/[a-z]/.test(t)) continue;
    for (const k of KINDS) {
      if (ran.has(k.kind)) continue;
      if (k.re.test(t)) { out.push({ kind: k.kind, sentence: s }); break; }
    }
  }
  return out;
}

const TRUTH = {
  start: 'I have not started anything: a reply cannot start a lab experiment. Tap **Start experiment** below to confirm it, or send `/lab start <goal>`.',
  stop: 'I have not stopped anything. To stop a lab experiment send `/lab stop <id>` (`/lab status` lists the ids); `/watch stop <id>` stops a watch.',
  watch: 'I am not watching this yet. Say "watch it" (or send `/watch`) and I will post a report here when it finishes.',
  change: 'I have not changed anything: no action ran in this reply.'
};

// The goal for a Start experiment button, from the operator's own words
// ("start an experiment to compare X and Y" → "compare X and Y").
export function goalFromPrompt(prompt) {
  let g = String(prompt || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!g || g.startsWith('/')) return '';
  g = g.replace(/^(?:(?:hey|ok|okay)\s+)?pg ?1[,:]?\s+/i, '')
    .replace(/^(?:please|can you|could you|would you|go ahead and|let'?s)\s+/i, '')
    .replace(/^(?:start|run|launch|kick off|begin|do|set up)\s+(?:a|an|the|another|new|one)?\s*(?:lab\s+)?(?:experiment|research(?:\s+run)?|run|test)\s*(?:to|on|about|into|for|that|which|:|-)?\s*/i, '')
    .replace(/[.!?]+$/, '')
    .trim();
  return g.length >= 3 ? g.slice(0, 200) : '';
}

// The kind from the operator's words (lib/lab/policy.mjs classifyLabKind:
// implement, build, prototype... is code); "fix", "patch" or a pull request
// are code too.
const KIND_OPT = (prompt) => {
  const k = classifyLabKind(prompt);
  if (k !== 'research') return ` --kind ${k}`;
  return /\b(?:code|patch|pull request|pr|fix)\b/i.test(prompt) ? ' --kind code' : '';
};

export function honestReply(text, { ran = new Set(), prompt = '', isOperator = false } = {}) {
  const claims = findFalseClaims(text, { ran });
  if (!claims.length) return { text, note: '', actions: [], claims };
  let out = String(text);
  const kinds = [];
  for (const c of claims) {
    if (!kinds.includes(c.kind)) kinds.push(c.kind);
    // The false sentence goes; a line break that ended it stays.
    out = out.replace(c.sentence, /\n$/.test(c.sentence) ? '\n' : ' ');
  }
  const truth = kinds.map((k) => TRUTH[k]).join(' ');
  out = `${out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()}\n\n${truth}`.trim();
  const actions = [];
  if (kinds.includes('start') && isOperator) {
    const goal = goalFromPrompt(prompt);
    const a = goal ? commandAction(`/lab start${KIND_OPT(prompt)} ${goal}`) : null;
    if (a) actions.push({ ...a, label: 'Start experiment', kind: 'confirm' });
  }
  return { text: out, note: `**Correction**: ${truth}`, actions, claims };
}
