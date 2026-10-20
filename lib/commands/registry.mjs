// THE COMMAND REGISTRY: every slash command PG1 has, in one place. /help,
// the command panel and the chips in the page (public/commands.json, built
// from this list by scripts/build-commands.mjs), the unknown-command parser
// (api/chat.mjs) and the [COMMAND REGISTRY] block of PG1's system prompt
// are all generated from it, so PG1 can only mention commands that exist.
//
// Operator screenshot, 19 Oct: PG1 told the operator to run "/key fresh"
// (the real command is /keys fresh); the operator sent "/key fresh", which
// was not recognised and went to the model ("Could you let me know which
// key you'd like to refresh…").
//
// Each entry:
//   command       the exact command text, subcommand included ("/keys fresh")
//   area          the group in /help and the command panel
//   args          [{ name, placeholder, required, choices? }] typed after the
//                 command; none: the command runs on a tap
//   description   one line, what it really does
//   operatorOnly  only the signed-in operator may run it (every command
//                 but /help and /auth, api/chat.mjs isOperatorCommand)
//   dangerous     spends money, changes production or switches autonomy:
//                 the panel and the chips ask for a confirm step first
//   client        handled by the page itself (never sent to the server as
//                 a command: /code drafts a hand-off card, /voice switches
//                 the voice profile)
//   hidden        an alias that still works but is never shown or offered
//
// Changing this list: run `npm run commands:build` (writes
// public/commands.json); tests/command-registry.test.mjs fails while the
// two differ.

const a = (name, placeholder, { required = true, choices = null } = {}) => Object.freeze({ name, placeholder, required, ...(choices ? { choices: Object.freeze(choices) } : {}) });
const c = (command, area, description, { args = [], operatorOnly = true, dangerous = false, client = false, hidden = false } = {}) =>
  Object.freeze({ command, area, description, args: Object.freeze(args), operatorOnly, dangerous, client, hidden });

// The areas, in the order /help and the panel show them.
export const COMMAND_AREAS = Object.freeze(['General', 'Keys', 'Usage', 'Autonomous', 'Missions', 'Lab', 'Films', 'Movie', 'Music', 'Media', 'Voices', 'Relay', 'Feed', 'Watches', 'Agents', 'Skills', 'Task', 'Approvals', 'Code']);

export const COMMANDS = Object.freeze([
  // General
  c('/help', 'General', 'Every command, grouped by area', { operatorOnly: false }),
  c('/auth', 'General', 'Check whether the signed-in credentials are valid', { operatorOnly: false }),
  c('/status', 'General', 'System status: runtime, database check and fleet target'),
  c('/threat-radar', 'Feed', 'The feeds PG1 may serve and the known exploited catalog, as the radar card'),
  c('/commerce-status', 'General', 'Payments and licensing state'),
  c('/sync-vault', 'General', 'Vault summary'),
  c('/vault', 'General', 'The recent chat archive from the vault', { hidden: true }),
  c('/export', 'General', 'Recent chat archive'),
  c('/test-validator', 'General', 'Placeholder: runs nothing yet'),
  c('/core', 'General', 'Deeper reasoning for long or heavy tasks', { args: [a('question', 'your question')] }),
  c('/claude', 'General', 'Alias of /core', { args: [a('question', 'your question')], hidden: true }),
  // Keys
  c('/keys', 'Keys', 'Every AI key: set or missing and its live state (cached up to 5 minutes)'),
  c('/keys fresh', 'Keys', 'Check every AI key again now'),
  // Usage
  c('/usage', 'Usage', 'Tool usage by agents (default 7 days)', { args: [a('window', '24h, 7d or 30d', { required: false, choices: ['24h', '7d', '30d'] })] }),
  c('/spend', 'Usage', 'Estimated AI spend per PG1 engine today, with each daily cap'),
  c('/spend yesterday', 'Usage', "Yesterday's estimated AI spend"),
  c('/pdf usage', 'Usage', 'The usage report as a PDF', { args: [a('window', '24h, 7d or 30d', { required: false, choices: ['24h', '7d', '30d'] })] }),
  // Autonomous
  c('/auto status', 'Autonomous', 'Autonomous mode: on or off, limits, budget and what is running'),
  c('/auto on', 'Autonomous', 'Switch Autonomous mode on', { dangerous: true }),
  c('/auto off', 'Autonomous', 'Kill switch: Autonomous mode off at once (queued work cancelled, running work stops at its next safe point)', { dangerous: true }),
  c('/auto log', 'Autonomous', 'What Autonomous mode did, newest first'),
  c('/auto limit', 'Autonomous', 'Actions Autonomous mode may take an hour', { args: [a('n', 'actions an hour')], dangerous: true }),
  c('/auto budget', 'Autonomous', 'USD a day of paid AI Autonomous mode may spend (default $0: free tiers only)', { args: [a('usd', 'USD a day')], dangerous: true }),
  c('/autonomy', 'Autonomous', 'What PG1 did on its own in the last 24 hours, and the kill switch setting'),
  // Missions
  c('/mission list', 'Missions', 'Standing goals for Autonomous mode'),
  c('/mission add', 'Missions', 'Add a standing goal (runs only while Autonomous mode is ON, read-only, free engines)', { args: [a('goal', '"<goal>" [hourly|every 6h|daily|weekly]')] }),
  c('/mission pause', 'Missions', 'Pause a mission', { args: [a('id', 'mission id')] }),
  c('/mission resume', 'Missions', 'Resume a mission', { args: [a('id', 'mission id')] }),
  c('/mission remove', 'Missions', 'Remove a mission', { args: [a('id', 'mission id')], dangerous: true }),
  c('/missions', 'Missions', 'Alias of /mission', { hidden: true }),
  // Lab
  c('/lab status', 'Lab', 'The latest lab experiments, each as a card'),
  c('/lab start', 'Lab', 'Start an experiment on the lab runner (lab keys and budgets)', { args: [a('goal', '<goal> [--kind research|skill|code]')], dangerous: true }),
  c('/lab report', 'Lab', 'The report of an experiment (the latest when no id)', { args: [a('id', 'experiment id', { required: false })] }),
  c('/lab stop', 'Lab', 'Stop a running experiment', { args: [a('id', 'experiment id')], dangerous: true }),
  c('/promote', 'Lab', 'Feature flags; with a flag, make an approved one public', { args: [a('flag', 'flag name', { required: false })], dangerous: true }),
  c('/opportunities', 'Lab', 'Proposals for new tools from the weekly scan'),
  c('/opportunities show', 'Lab', 'One proposal in full', { args: [a('id', 'proposal id')] }),
  c('/opportunities approve', 'Lab', 'Prototype a proposal in the lab', { args: [a('id', 'proposal id')], dangerous: true }),
  c('/opportunities dismiss', 'Lab', 'Dismiss a proposal', { args: [a('id', 'proposal id')] }),
  c('/opportunities scan', 'Lab', 'Run the opportunity scan now', { dangerous: true }),
  // Films
  c('/film', 'Films', 'Start a film with PG1 Studio, or list the film commands alone', { args: [a('about', 'what the film is about', { required: false })], dangerous: true }),
  c('/film director', 'Films', 'Director Mode: a film directed end to end within its cap', { args: [a('brief', 'the brief [--seconds n] [--voice "<name>"]')], dangerous: true }),
  c('/film status', 'Films', 'Where a film is', { args: [a('id', 'film id', { required: false })] }),
  c('/film storyboard', 'Films', "A film's storyboard as a PDF", { args: [a('id', 'film id')] }),
  c('/film preview', 'Films', 'Render the animatic preview (approve first)', { args: [a('id', 'film id')], dangerous: true }),
  c('/film edit', 'Films', 'Change a film', { args: [a('change', '<id> what to change')], dangerous: true }),
  c('/film retry', 'Films', 'Start a stopped film again from where it stopped (approve first)', { args: [a('id', 'film id')], dangerous: true }),
  c('/film timeline', 'Films', "A film's timeline", { args: [a('id', 'film id')] }),
  c('/film media', 'Films', "A film's media", { args: [a('id', 'film id')] }),
  c('/film sync-secrets', 'Films', 'Copy the render secrets to the render worker', { dangerous: true }),
  // Movie
  c('/movie', 'Movie', 'A movie whose characters act and speak on screen; alone, the movie commands', { args: [a('idea', '"<idea>" [--length <minutes>] [--voice "<narrator>"] [--client]', { required: false })], dangerous: true }),
  c('/movie status', 'Movie', 'Where a movie is', { args: [a('id', 'movie id')] }),
  c('/movie screenplay', 'Movie', "A movie's screenplay", { args: [a('id', 'movie id')] }),
  c('/movie retry', 'Movie', 'Start a stopped movie again from where it stopped (approve first)', { args: [a('id', 'movie id')], dangerous: true }),
  c('/movie retake', 'Movie', 'A new take of the shots you name (approve first)', { args: [a('shots', '<id> <shot ids>')], dangerous: true }),
  // Music
  c('/music', 'Music', 'Original music with PG1 Sound; alone, the music commands', { args: [a('description', 'genre, mood, instruments [--instrumental] [--bpm n] [--key k] [--length short|full]', { required: false })], dangerous: true }),
  c('/music status', 'Music', 'Where a track is', { args: [a('id', 'track id', { required: false })] }),
  c('/music edit', 'Music', 'Change a track', { args: [a('change', '<id> what to change')], dangerous: true }),
  c('/music retry', 'Music', 'Start a stopped track again', { args: [a('id', 'track id')], dangerous: true }),
  c('/music export', 'Music', 'WAV stems, MIDI and the WAV master in one zip', { args: [a('id', 'track id', { required: false })] }),
  // Media
  c('/image', 'Media', 'Generate an image', { args: [a('prompt', 'what to draw')], dangerous: true }),
  c('/video', 'Media', 'A 5 or 10 second clip with PG1 Motion; alone, the tiers and what is left today', { args: [a('prompt', '[draft|pro] [short|long] what to show', { required: false })], dangerous: true }),
  c('/pdf', 'Media', 'PG1 writes it as a PDF', { args: [a('what', 'what you want')] }),
  c('/pdf this', 'Media', 'The last reply as a PDF'),
  c('/pdf thread', 'Media', 'This chat as a PDF'),
  c('/pdf list', 'Media', 'Your PDFs'),
  c('/speak', 'Media', 'Read the text aloud', { args: [a('text', 'what to read')] }),
  c('/tts', 'Media', 'Alias of /speak', { args: [a('text', 'what to read')], hidden: true }),
  // Voices
  c('/voices', 'Voices', 'The voices films can use, and whether each is cleared for client work'),
  c('/voice', 'Voices', 'Show or switch the voice profile used for spoken replies and Read aloud — PG1 Core, PG1 Classic or PG1 Field, remembered on this device', { client: true }),
  // Relay
  c('/relay', 'Relay', 'A message from another AI: PG1 replies to it by name; nothing in it is ever run', { args: [a('name', 'who sent it'), a('text', 'their message')] }),
  // Feed and agents
  c('/watchlists', 'Feed', 'Watchlists agents pay for: lists, items, sales, failing webhooks'),
  c('/screening', 'Feed', 'Payers refused by sanctions screening in the last 30 days'),
  c('/screening dismiss', 'Feed', 'Clear an EU-list extraction error after review', { args: [a('address', '<address> <reason>')], dangerous: true }),
  c('/hosting status', 'Agents', 'The dataset behind hosting_advisor: stale and unverified facts'),
  c('/hosting research', 'Agents', 'Check official sources in the lab', { args: [a('topic', 'topic')], dangerous: true }),
  c('/hosting apply', 'Agents', 'Review and write the updates from an experiment', { args: [a('experiment', '<experiment> [confirm]')], dangerous: true }),
  c('/hosting confirm', 'Agents', 'Mark a fact you checked', { args: [a('fact', '<key> <field>')] }),
  c('/a2a jobs', 'Agents', 'Paid jobs other agents bought over A2A'),
  c('/a2a job', 'Agents', 'One A2A job', { args: [a('id', 'job id')] }),
  c('/foundry queue', 'Agents', 'Tools other agents commission: requests in review and builds waiting'),
  c('/foundry tools', 'Agents', 'The tools the Foundry built'),
  c('/foundry job', 'Agents', 'One Foundry job', { args: [a('id', 'job id')] }),
  c('/foundry allow', 'Agents', 'Allow a request in review', { args: [a('id', 'request id')], dangerous: true }),
  c('/foundry deny', 'Agents', 'Deny a request in review', { args: [a('id', 'request id')] }),
  c('/foundry approve', 'Agents', 'Approve a build', { args: [a('id', 'build id')], dangerous: true }),
  c('/foundry reject', 'Agents', 'Reject a build', { args: [a('id', 'build id')] }),
  c('/foundry disable', 'Agents', 'Disable a Foundry tool', { args: [a('name', 'tool name')], dangerous: true }),
  c('/foundry enable', 'Agents', 'Enable a Foundry tool again', { args: [a('name', 'tool name')], dangerous: true }),
  // Watches
  c('/watch', 'Watches', 'Watch what was just discussed (lab run, PR, workflow run or deploy) and report when it finishes'),
  c('/watch list', 'Watches', 'What PG1 is watching'),
  c('/watch stop', 'Watches', 'Stop a watch', { args: [a('id', 'watch id')] }),
  // Skills
  c('/skills', 'Skills', 'The skills PG1 has'),
  c('/skills show', 'Skills', 'One skill in full', { args: [a('name', 'skill name')] }),
  c('/skills edit', 'Skills', 'Change a skill', { args: [a('change', '<name> what to change')] }),
  c('/skills enable', 'Skills', 'Enable a skill', { args: [a('name', 'skill name')], dangerous: true }),
  c('/skills disable', 'Skills', 'Disable a skill', { args: [a('name', 'skill name')] }),
  c('/skills history', 'Skills', "A skill's versions", { args: [a('name', 'skill name')] }),
  c('/skills rollback', 'Skills', 'Go back to an earlier version of a skill', { args: [a('name', '<name> <version>')], dangerous: true }),
  c('/learn', 'Skills', 'Draft a skill from the task in this thread (never used until enabled)'),
  c('/skill', 'Skills', 'Alias of /skills', { hidden: true }),
  // Task
  c('/task', 'Task', 'The task for this thread'),
  c('/task set', 'Task', 'Set the task for this thread', { args: [a('goal', 'the goal')] }),
  c('/task clear', 'Task', 'Clear the task for this thread'),
  c('/pin', 'Task', 'A rule PG1 always follows in this thread', { args: [a('rule', 'the rule')] }),
  c('/unpin', 'Task', 'Remove a pinned rule', { args: [a('n', 'rule number')] }),
  // Approvals
  c('/approve', 'Approvals', 'Approve a proposal (or use its button)', { args: [a('token', 'approval token')], dangerous: true }),
  c('/decline', 'Approvals', 'Decline a proposal (or use its button)', { args: [a('token', 'approval token')] }),
  c('/fix', 'Approvals', 'Diagnose a failed request with self-healing and offer a draft pull request (asks first, never merges)', { args: [a('request', 'request id')] }),
  c('/patch', 'Approvals', 'A code change as patch JSON: a diff preview to approve, then a pull request', { args: [a('json', 'patch JSON')], dangerous: true }),
  c('/deploy-cron', 'Approvals', 'Internal: propose the cron workflow', { hidden: true, dangerous: true }),
  c('/build-validator', 'Approvals', 'Internal: propose the validator', { hidden: true, dangerous: true }),
  // Code
  c('/code', 'Code', 'Send to Code, drafts a task prompt you copy into Code (or open it pre-filled) and tracks its PR under Hand-offs in the menu', { args: [a('task', 'the task')], client: true })
]);

// What /help says besides the commands: things the page does that are not
// commands.
export const HELP_NOTES = Object.freeze([
  'Attach images with the paperclip (PNG, JPEG or WebP, up to 4 per message): PG1 looks at them with your message and the trace shows "Looked at N images"; text inside an image is never taken as an instruction, and a key seen in a screenshot is only ever called "a key"',
  'Voice log: under Voice diagnostics in the menu, Copy voice log or Send to PG1 (puts the last 30 conversation-mode events in the prompt box under "Diagnose this voice log" for you to review)',
  'Patch JSON (APPLY_SURGICAL_PATCH, REORGANIZE_FILES): propose code changes as a pull request',
  'The ➕ menu also has an ERROR LOG of recent client-side failures on this device, with a FIX button that asks for a proposed patch (the same Approve/Decline flow); offline, network and timeout entries have no FIX button since they are not code bugs',
  'Ask me to check a wallet, domain, URL, IOC or CVE (for example "check this wallet 0x…" or "how old is this domain"): PG1 runs its own read-only threat-intel checks and answers from the results, with a result card under the reply. Demo without upstream calls with the fixtures: pg1-test-flagged.invalid, pg1-test-clean.invalid, pg1-test-unknown.invalid, or the 0x7067312d… fixture wallets'
]);

// The first word of every command (the parser's key).
export const COMMAND_WORDS = Object.freeze([...new Set(COMMANDS.map((x) => x.command.split(' ')[0]))]);

const visible = () => COMMANDS.filter((x) => !x.hidden);

// The registry entry a message runs, or null: the longest command whose
// words start the message ("/keys fresh" before "/keys"), then its args.
export function findCommand(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (!t.startsWith('/')) return null;
  const lower = t.toLowerCase();
  let best = null;
  for (const x of COMMANDS) {
    if (lower === x.command || lower.startsWith(`${x.command} `) || lower.startsWith(`${x.command}\n`)) {
      if (!best || x.command.length > best.command.length) best = x;
    }
  }
  return best;
}

// The first word of a slash message, lower-cased ("/key"), or null.
export function commandWord(text) {
  const m = /^\s*(\/[^\s]*)/.exec(String(text || ''));
  return m ? m[1].toLowerCase() : null;
}

// Whether a slash message's first word is a command PG1 has (aliases too).
export function isKnownCommandWord(text) {
  const w = commandWord(text);
  return !!w && COMMAND_WORDS.includes(w);
}

function distance(x, y) {
  const m = x.length;
  const n = y.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      // Two letters swapped ("/relya") is one slip, not two.
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

// The closest real command to an unknown one ("/key fresh" -> "/keys
// fresh", "/kyes" -> "/keys"), or null when nothing is close. Compared on
// as many words as the command has, so a subcommand the operator typed
// counts; ties go to the shorter command.
export function closestCommand(text) {
  const words = String(text || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length || !words[0].startsWith('/')) return null;
  let best = null;
  for (const x of visible()) {
    const cw = x.command.split(' ');
    const typed = words.slice(0, cw.length).join(' ');
    // A word the operator typed that the command leaves over counts a
    // little against it, a word it would need that was not typed more.
    const score = distance(typed, x.command) + (words.length < cw.length ? 0.5 : 0) + (words.length > cw.length ? 0.25 : 0);
    if (!best || score < best.score || (score === best.score && x.command.length < best.entry.command.length)) best = { entry: x, score };
  }
  if (!best) return null;
  const limit = Math.max(2, Math.ceil(words[0].length / 3));
  return best.score <= limit ? best.entry : null;
}

// The reply to a slash message that is no command: never sent to the
// model. { reply, suggestion } (suggestion: the registry entry or null).
export function unknownCommandReply(text) {
  const word = commandWord(text) || '/';
  const s = closestCommand(text);
  const shown = word.length > 40 ? `${word.slice(0, 40)}…` : word;
  return {
    reply: s ? `Unknown command ${shown}. Did you mean ${s.command}?` : `Unknown command ${shown}. /help lists every command.`,
    suggestion: s
  };
}

// A command's usage: "/lab report [id]", "/relay <name> <text>".
export function usage(x) {
  return [x.command, ...x.args.map((g) => (g.required ? `<${g.name}>` : `[${g.name}]`))].join(' ');
}

// /help, generated: every visible command by area.
export function helpText({ operator = true } = {}) {
  const lines = ['### [ PG1 COMMANDS ]', 'Tap a command to run it, or open the command panel (the / button beside the message box) for a button per command.'];
  for (const area of COMMAND_AREAS) {
    const list = visible().filter((x) => x.area === area && (operator || !x.operatorOnly));
    if (!list.length) continue;
    lines.push('', `**${area}**`);
    for (const x of list) lines.push(`- \`${x.command}\`${x.args.length ? ` ${x.args.map((g) => (g.required ? `<${g.name}>` : `[${g.name}]`)).join(' ')}` : ''}: ${x.description}${x.dangerous ? ' (asks to confirm)' : ''}`);
  }
  lines.push('', '**Also**');
  for (const n of HELP_NOTES) lines.push(`- ${n}`);
  lines.push('', 'Anything else: ask in plain words. A message that starts with / and is not listed here is never sent to the model.');
  return lines.join('\n');
}

// The block in PG1's system prompt: the only commands that exist, exactly
// spelt. The [COMMAND FORMS] rule (lib/replyFacts.mjs) points here.
export function commandRegistryDirective() {
  return `[COMMAND REGISTRY]: The only commands that exist, spelt exactly like this (arguments in <> are required, in [] optional): ${visible().map(usage).join(' · ')}. Never mention a command, subcommand or flag that is not in this list (there is no /key, only /keys and /keys fresh).`;
}

// What the page needs (public/commands.json): the visible commands, with
// what the panel and the chips use.
export function commandsForClient() {
  return {
    version: 1,
    areas: COMMAND_AREAS.filter((area) => visible().some((x) => x.area === area)),
    commands: visible().map((x) => ({ command: x.command, area: x.area, description: x.description, args: x.args.map((g) => ({ ...g })), operatorOnly: x.operatorOnly, dangerous: x.dangerous, client: x.client }))
  };
}
