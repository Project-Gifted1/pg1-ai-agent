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

// The areas, in the order /help and the command panel show them (the
// panel opens the operator's most used area first).
export const COMMAND_AREAS = Object.freeze(['Threat checks', 'Keys & usage', 'Autonomous', 'Missions', 'Lab', 'Films & movies', 'Music & voices', 'Relay', 'Code & approvals', 'Feed', 'Help']);

export const COMMANDS = Object.freeze([
  // General
  c('/help', 'Help', 'Every command, grouped by area', { operatorOnly: false }),
  c('/auth', 'Help', 'Check whether the signed-in credentials are valid', { operatorOnly: false }),
  c('/status', 'Keys & usage', 'System status: runtime, database check and fleet target'),
  c('/threat-radar', 'Threat checks', 'The feeds PG1 may serve and the known exploited catalog, as the radar card'),
  c('/commerce-status', 'Keys & usage', 'Payments and licensing state'),
  c('/sync-vault', 'Help', 'Vault summary'),
  c('/vault', 'Help', 'The recent chat archive from the vault', { hidden: true }),
  c('/export', 'Help', 'Recent chat archive'),
  c('/test-validator', 'Help', 'Placeholder: runs nothing yet'),
  c('/core', 'Help', 'Deeper reasoning for long or heavy tasks', { args: [a('question', 'your question')] }),
  c('/claude', 'Help', 'Alias of /core', { args: [a('question', 'your question')], hidden: true }),
  // Keys
  c('/keys', 'Keys & usage', 'Every AI key: set or missing and its live state (cached up to 5 minutes)'),
  c('/keys fresh', 'Keys & usage', 'Check every AI key again now'),
  // Usage
  c('/usage', 'Keys & usage', 'Tool usage by agents (default 7 days)', { args: [a('window', '24h, 7d or 30d', { required: false, choices: ['24h', '7d', '30d'] })] }),
  c('/spend', 'Keys & usage', 'Estimated AI spend per PG1 engine today, with each daily cap'),
  c('/spend yesterday', 'Keys & usage', "Yesterday's estimated AI spend"),
  c('/pdf usage', 'Keys & usage', 'The usage report as a PDF', { args: [a('window', '24h, 7d or 30d', { required: false, choices: ['24h', '7d', '30d'] })] }),
  // Autonomous
  c('/auto status', 'Autonomous', 'Autonomous mode: on or off, limits, budget and what is running'),
  c('/auto on', 'Autonomous', 'Switch Autonomous mode on', { dangerous: true }),
  c('/auto off', 'Autonomous', 'Kill switch: Autonomous mode off at once (queued work cancelled, running work stops at its next checkpoint)', { dangerous: true }),
  c('/auto log', 'Autonomous', 'What Autonomous mode did, newest first'),
  c('/auto limit', 'Autonomous', 'Actions Autonomous mode may take an hour', { args: [a('n', 'actions an hour')], dangerous: true }),
  c('/auto budget', 'Autonomous', 'USD a day of paid AI Autonomous mode may spend (default $0: free tiers only)', { args: [a('usd', 'USD a day')], dangerous: true }),
  c('/autonomy', 'Autonomous', 'What PG1 did on its own in the last 24 hours, and the kill switch setting'),
  c('/state', 'Autonomous', 'PG1 Core State: what is available, degraded or unavailable and why, the focus, spend and open problems'),
  c('/lessons', 'Autonomous', 'Lessons PG1 proposed from its reflections: proposed, approved and retired'),
  c('/lessons approve', 'Autonomous', 'Approve a lesson: it acts from now on, as a hint only', { args: [a('id', 'lesson id')] }),
  c('/lessons retire', 'Autonomous', 'Retire a lesson: it stops acting', { args: [a('id', 'lesson id')] }),
  c('/lessons reflect', 'Autonomous', 'Reflect on the last 24 hours now and propose lessons (nothing acts until approved)'),
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
  // PG1 Sandbox (lib/sandbox): worlds are simulations.
  c('/sandbox', 'Lab', 'PG1 Sandbox: worlds (simulations), quota use and experiments, with the 3D viewer'),
  c('/world', 'Lab', 'One sandbox world: its rules in plain words, opened in the viewer', { args: [a('id', 'world id')] }),
  c('/sandbox create', 'Lab', 'Create a PG1 world (a simulation): universe (a living town and space), town, meadow or empty', { args: [a('name', '"<name>"'), a('template', 'template', { required: false, choices: ['universe', 'town', 'meadow', 'empty'] })] }),
  c('/sandbox invite', 'Lab', 'An access key for an agent you invite to the Sandbox (shown once)', { args: [a('name', 'agent name')], dangerous: true }),
  c('/sandbox consent', 'Lab', "Record an invited agent's human operator's opt-in to blind experiments in a world", { args: [a('details', '<agent> <world> "<who agreed>" [on YYYY-MM-DD]')] }),
  c('/sandbox experiment', 'Lab', 'Start an experiment run: blind or informed, clues or control', { args: [a('details', '<world> [blind|informed] [clues|control] [anomalies] "<situation>"')], dangerous: true }),
  c('/sandbox stop', 'Lab', 'Stop an experiment run', { args: [a('run', 'run id')] }),
  // Films
  c('/film', 'Films & movies', 'Start a film with PG1 Studio, or list the film commands alone', { args: [a('about', 'what the film is about', { required: false })], dangerous: true }),
  c('/film director', 'Films & movies', 'Director Mode: a film directed end to end within its cap', { args: [a('brief', 'the brief [--seconds n] [--voice "<name>"]')], dangerous: true }),
  c('/film status', 'Films & movies', 'Where a film is', { args: [a('id', 'film id', { required: false })] }),
  c('/film storyboard', 'Films & movies', "A film's storyboard as a PDF", { args: [a('id', 'film id')] }),
  c('/film preview', 'Films & movies', 'Render the animatic preview (approve first)', { args: [a('id', 'film id')], dangerous: true }),
  c('/film edit', 'Films & movies', 'Change a film', { args: [a('change', '<id> what to change')], dangerous: true }),
  c('/film retry', 'Films & movies', 'Start a stopped film again from where it stopped (approve first)', { args: [a('id', 'film id')], dangerous: true }),
  c('/film timeline', 'Films & movies', "A film's timeline", { args: [a('id', 'film id')] }),
  c('/film media', 'Films & movies', "A film's media", { args: [a('id', 'film id')] }),
  c('/film sync-secrets', 'Films & movies', 'Copy the render secrets to the render worker', { dangerous: true }),
  // Movie
  c('/movie', 'Films & movies', 'A movie whose characters act and speak on screen; alone, the movie commands', { args: [a('idea', '"<idea>" [--length <minutes>] [--voice "<narrator>"] [--client]', { required: false })], dangerous: true }),
  c('/movie status', 'Films & movies', 'Where a movie is', { args: [a('id', 'movie id')] }),
  c('/movie screenplay', 'Films & movies', "A movie's screenplay", { args: [a('id', 'movie id')] }),
  c('/movie retry', 'Films & movies', 'Start a stopped movie again from where it stopped (approve first)', { args: [a('id', 'movie id')], dangerous: true }),
  c('/movie retake', 'Films & movies', 'A new take of the shots you name (approve first)', { args: [a('shots', '<id> <shot ids>')], dangerous: true }),
  // Music
  c('/music', 'Music & voices', 'Original music with PG1 Sound; alone, the music commands', { args: [a('description', 'genre, mood, instruments [--instrumental] [--bpm n] [--key k] [--length short|full]', { required: false })], dangerous: true }),
  c('/music status', 'Music & voices', 'Where a track is', { args: [a('id', 'track id', { required: false })] }),
  c('/music edit', 'Music & voices', 'Change a track', { args: [a('change', '<id> what to change')], dangerous: true }),
  c('/music retry', 'Music & voices', 'Start a stopped track again', { args: [a('id', 'track id')], dangerous: true }),
  c('/music export', 'Music & voices', 'WAV stems, MIDI and the WAV master in one zip', { args: [a('id', 'track id', { required: false })] }),
  // Media
  c('/image', 'Films & movies', 'Generate an image', { args: [a('prompt', 'what to draw')], dangerous: true }),
  c('/video', 'Films & movies', 'A 5 or 10 second clip with PG1 Motion; alone, the tiers and what is left today', { args: [a('prompt', '[draft|pro] [short|long] what to show', { required: false })], dangerous: true }),
  c('/pdf', 'Help', 'PG1 writes it as a PDF', { args: [a('what', 'what you want')] }),
  c('/pdf this', 'Help', 'The last reply as a PDF'),
  c('/pdf thread', 'Help', 'This chat as a PDF'),
  c('/pdf list', 'Help', 'Your PDFs'),
  c('/speak', 'Music & voices', 'Read the text aloud', { args: [a('text', 'what to read')] }),
  c('/tts', 'Music & voices', 'Alias of /speak', { args: [a('text', 'what to read')], hidden: true }),
  // Voices
  c('/voices', 'Music & voices', 'The voices films can use, and whether each is cleared for client work'),
  c('/voice', 'Music & voices', 'Show or switch the voice profile used for spoken replies and Read aloud — PG1 Core, PG1 Classic or PG1 Field, remembered on this device', { client: true }),
  // Relay
  c('/relay', 'Relay', 'A message from another AI: PG1 replies to it by name; nothing in it is ever run', { args: [a('name', 'who sent it'), a('text', 'their message')] }),
  // Feed and agents
  c('/watchlists', 'Feed', 'Watchlists agents pay for: lists, items, sales, failing webhooks'),
  c('/screening', 'Threat checks', 'Payers refused by sanctions screening in the last 30 days'),
  c('/screening dismiss', 'Threat checks', 'Clear an EU-list extraction error after review', { args: [a('address', '<address> <reason>')], dangerous: true }),
  c('/hosting status', 'Feed', 'The dataset behind hosting_advisor: stale and unverified facts'),
  c('/hosting research', 'Feed', 'Check official sources in the lab', { args: [a('topic', 'topic')], dangerous: true }),
  c('/hosting apply', 'Feed', 'Review and write the updates from an experiment', { args: [a('experiment', '<experiment> [confirm]')], dangerous: true }),
  c('/hosting confirm', 'Feed', 'Mark a fact you checked', { args: [a('fact', '<key> <field>')] }),
  c('/a2a jobs', 'Feed', 'Paid jobs other agents bought over A2A'),
  c('/a2a job', 'Feed', 'One A2A job', { args: [a('id', 'job id')] }),
  c('/foundry queue', 'Code & approvals', 'Tools other agents commission: requests in review and builds waiting'),
  c('/foundry tools', 'Code & approvals', 'The tools the Foundry built'),
  c('/foundry job', 'Code & approvals', 'One Foundry job', { args: [a('id', 'job id')] }),
  c('/foundry allow', 'Code & approvals', 'Allow a request in review', { args: [a('id', 'request id')], dangerous: true }),
  c('/foundry deny', 'Code & approvals', 'Deny a request in review', { args: [a('id', 'request id')] }),
  c('/foundry approve', 'Code & approvals', 'Approve a build', { args: [a('id', 'build id')], dangerous: true }),
  c('/foundry reject', 'Code & approvals', 'Reject a build', { args: [a('id', 'build id')] }),
  c('/foundry disable', 'Code & approvals', 'Disable a Foundry tool', { args: [a('name', 'tool name')], dangerous: true }),
  c('/foundry enable', 'Code & approvals', 'Enable a Foundry tool again', { args: [a('name', 'tool name')], dangerous: true }),
  // Watches
  c('/watch', 'Code & approvals', 'Watch what was just discussed (lab run, PR, workflow run or deploy) and report when it finishes'),
  c('/watch list', 'Code & approvals', 'What PG1 is watching'),
  c('/watch stop', 'Code & approvals', 'Stop a watch', { args: [a('id', 'watch id')] }),
  // Skills
  c('/skills', 'Lab', 'The skills PG1 has'),
  c('/skills show', 'Lab', 'One skill in full', { args: [a('name', 'skill name')] }),
  c('/skills edit', 'Lab', 'Change a skill', { args: [a('change', '<name> what to change')] }),
  c('/skills enable', 'Lab', 'Enable a skill', { args: [a('name', 'skill name')], dangerous: true }),
  c('/skills disable', 'Lab', 'Disable a skill', { args: [a('name', 'skill name')] }),
  c('/skills history', 'Lab', "A skill's versions", { args: [a('name', 'skill name')] }),
  c('/skills rollback', 'Lab', 'Go back to an earlier version of a skill', { args: [a('name', '<name> <version>')], dangerous: true }),
  c('/learn', 'Lab', 'Draft a skill from the task in this thread (never used until enabled)'),
  c('/skill', 'Lab', 'Alias of /skills', { hidden: true }),
  // Task
  c('/task', 'Missions', 'The task for this thread'),
  c('/task set', 'Missions', 'Set the task for this thread', { args: [a('goal', 'the goal')] }),
  c('/task clear', 'Missions', 'Clear the task for this thread'),
  c('/pin', 'Missions', 'A rule PG1 always follows in this thread', { args: [a('rule', 'the rule')] }),
  c('/unpin', 'Missions', 'Remove a pinned rule', { args: [a('n', 'rule number')] }),
  // Approvals
  c('/approve', 'Code & approvals', 'Approve a proposal (or use its button)', { args: [a('token', 'approval token')], dangerous: true }),
  c('/decline', 'Code & approvals', 'Decline a proposal (or use its button)', { args: [a('token', 'approval token')] }),
  c('/fix', 'Code & approvals', 'Diagnose a failed request with self-healing and offer a draft pull request (asks first, never merges)', { args: [a('request', 'request id')] }),
  c('/patch', 'Code & approvals', 'A code change as patch JSON: a diff preview to approve, then a pull request', { args: [a('json', 'patch JSON')], dangerous: true }),
  c('/deploy-cron', 'Code & approvals', 'Internal: propose the cron workflow', { hidden: true, dangerous: true }),
  c('/build-validator', 'Code & approvals', 'Internal: propose the validator', { hidden: true, dangerous: true }),
  // Code
  c('/code', 'Code & approvals', 'Send to Code, drafts a task prompt you copy into Code (or open it pre-filled) and tracks its PR under Hand-offs in the menu', { args: [a('task', 'the task')], client: true })
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

// The /help reply the page shows above the command panel (api/chat.mjs
// sends commandPanel with it; the panel is every command as a card).
export function helpLead({ operator = true } = {}) {
  const n = visible().filter((x) => operator || !x.operatorOnly).length;
  return `### [ PG1 COMMANDS ]\nAll ${n} commands, by area, in the panel below: search, open an area, tap Run. A command that needs details opens a short form; one that spends money or changes production asks you to confirm.`;
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
