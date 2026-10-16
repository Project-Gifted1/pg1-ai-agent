// Buttons under a reply: real commands the operator can tap (or confirm by
// voice) instead of being told to type them.
//
//   replyActions({ prompt, reply, ... })  [{ label, command, confirm, kind }]
//
// Every action's command is checked against COMMANDS, the commands that
// really exist with the arguments they take, so a button can never run
// something PG1 invented. Actions come from three places, in this order:
//   1. the command's own reply (/lab report: Stop while it runs, and
//      /lab status). /lab status puts a Report button (and Stop while it
//      runs) on each experiment's own card instead (lib/lab/card.mjs), so
//      every lab listed has one, however many there are
//   2. commands the reply mentions in plain text, with their arguments
//      (one in backticks or [ brackets ] is already a chip in the text)
//   3. the conversation: a long written answer gets "Make it a PDF"
// confirm: true marks a button that changes something (stop, promote): the
// page asks for a second tap, and voice asks "Stop it? Say yes or no".
// At most MAX_ACTIONS. Pure: api/chat.mjs puts the list on the reply.

export const MAX_ACTIONS = 4;
const ID8 = '[0-9a-f]{8}';

// The commands a button may run: pattern for the whole command, a label,
// and whether it needs a second tap.
export const COMMANDS = Object.freeze([
  { re: /^\/lab status$/, label: () => 'Lab status' },
  // The operator-confirmed start (lib/honestActions.mjs): /lab start runs
  // through the autonomy policy, the lab budgets and the kill switch.
  { re: /^\/lab start(?: --kind (?:research|skill|code))? [^\s/][^\n]{2,199}$/, label: () => 'Start experiment', confirm: true },
  { re: /^\/watch(?: list)?$/, label: () => 'Watches' },
  { re: new RegExp(`^\\/watch stop (${ID8})$`), label: (m) => `Stop watch ${m[1]}` },
  { re: new RegExp(`^\\/lab report(?: (${ID8}))?$`), label: (m) => (m[1] ? `Lab report ${m[1]}` : 'Latest lab report') },
  { re: new RegExp(`^\\/lab stop (${ID8})$`), label: (m) => `Stop experiment ${m[1]}`, confirm: true },
  { re: /^\/promote$/, label: () => 'Feature flags' },
  { re: /^\/promote ([a-z0-9:_-]{2,64})$/, label: (m) => `Make ${m[1]} public`, confirm: true },
  { re: /^\/pdf (this|thread|list)$/, label: (m) => ({ this: 'Make it a PDF', thread: 'This chat as a PDF', list: 'My PDFs' })[m[1]] },
  { re: /^\/pdf usage(?: (24h|7d|30d))?$/, label: () => 'Usage report PDF' },
  { re: /^\/usage(?: (24h|7d|30d))?$/, label: (m) => `Usage${m[1] ? ` ${m[1]}` : ''}` },
  { re: /^\/spend(?: yesterday)?$/, label: (m) => (/yesterday/.test(m[0]) ? 'Spend yesterday' : 'Spend today') },
  { re: /^\/status$/, label: () => 'System status' },
  { re: /^\/task$/, label: () => 'Task' },
  { re: /^\/autonomy$/, label: () => 'Autonomy log' },
  { re: /^\/opportunities$/, label: () => 'Opportunities' },
  { re: /^\/skills$/, label: () => 'Skills' },
  { re: /^\/a2a jobs$/, label: () => 'A2A jobs' },
  { re: /^\/foundry queue$/, label: () => 'Foundry queue' },
  { re: /^\/watchlists$/, label: () => 'Watchlists' },
  { re: /^\/screening$/, label: () => 'Screening' },
  { re: /^\/hosting status$/, label: () => 'Hosting dataset' },
  { re: /^\/film$/, label: () => 'Film commands' },
  { re: /^\/music$/, label: () => 'Music commands' },
  { re: /^\/help$/, label: () => 'All commands' }
]);

// { label, command, confirm } for a real command, else null.
export function commandAction(text) {
  const command = String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (!command.startsWith('/') || command.length > (command.startsWith('/lab start ') ? 240 : 80)) return null;
  for (const c of COMMANDS) {
    const m = c.re.exec(command);
    if (m) return { label: c.label(m), command, confirm: !!c.confirm, kind: 'command' };
  }
  return null;
}

// Commands a reply mentions, longest real form first: "/lab report
// e2981021" in backticks, brackets or plain text. Invented ones are left out.
export function mentionedCommands(text) {
  const t = String(text || '');
  const out = [];
  const re = /(?:^|[\s`[(“"'])(\/[a-z][a-z0-9-]*(?: [a-z0-9:_-]+){0,2})/gi;
  let m;
  while ((m = re.exec(t))) {
    const words = m[1].replace(/[.,;:!?)\]`'"”]+$/, '').split(' ');
    for (let n = words.length; n >= 1; n--) {
      const a = commandAction(words.slice(0, n).join(' '));
      // A Start experiment button only ever comes from the operator's own
      // words (lib/honestActions.mjs), never from a goal cut out of a reply.
      if (a && a.command.startsWith('/lab start ')) break;
      if (a) { out.push(a); break; }
    }
  }
  return out;
}

const words = (t) => String(t || '').trim().split(/\s+/).filter(Boolean).length;

export function replyActions({ prompt = '', reply = '', hasPdf = false, pendingApproval = false } = {}) {
  const p = String(prompt || '').trim().toLowerCase();
  const r = String(reply || '');
  if (!r || pendingApproval) return [];
  let list = [];
  if (/^\/lab report\b/.test(p)) {
    const head = new RegExp(`^### \\[ LAB (${ID8}) · \\w+ · (\\w+) \\]`).exec(r);
    if (head && (head[2] === 'running' || head[2] === 'queued')) list.push(commandAction(`/lab stop ${head[1]}`));
    list.push(commandAction('/lab status'));
  }
  // Commands the reply mentions in plain text, except the one just run. A
  // command in backticks or [ brackets ] is already a button in the text.
  list = list.concat(mentionedCommands(r.replace(/`[^`\n]*`|\[[^\]\n]*\]/g, ' ')).filter((a) => a.command !== p));
  // A long written answer from the model: offer the PDF.
  if (!p.startsWith('/') && !hasPdf && words(r) >= 120) list.push(commandAction('/pdf this'));
  const seen = new Set();
  return list.filter((a) => a && !seen.has(a.command) && seen.add(a.command)).slice(0, MAX_ACTIONS);
}
