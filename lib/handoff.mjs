// Send to Code: PG1's hand-off of a code-change task to the operator's own
// coding agent session (claude.ai/code, on the operator's own subscription).
//
// Everything here is deterministic string work - no model call of any kind.
// PG1 never calls Anthropic (or any model) to draft a hand-off, and never
// holds or uses the operator's subscription/OAuth credentials: it only
// builds a prompt the operator copies, and later reads GitHub to see whether
// the agent opened a PR whose title carries the task ID.
//
// Used by api/handoffs.mjs. stripSecrets() has a twin in public/index.html
// (stripSecretsClient) that re-checks the operator's edits before copying;
// tests/handoff.test.mjs runs both over the same inputs so they can't drift.

import { randomBytes } from 'node:crypto';

export const HANDOFF_STATUSES = ['drafted', 'sent', 'pr_open', 'merged', 'closed'];

export const DEFAULT_HANDOFF_REPO = 'Project-Gifted1/pg1-ai-agent';

// Repos the operator can hand work off for. A hand-off only ever targets one
// of these, so the GitHub token is never pointed at an arbitrary repo.
export const KNOWN_HANDOFF_REPOS = [
  'Project-Gifted1/pg1-ai-agent',
  'Project-Gifted1/x402',
  'Project-Gifted1/sovereign-threat-pipeline',
  'Project-Gifted1/awesome-x402',
  'Project-Gifted1/gold-402',
  'Project-Gifted1/Trucker-Pulse',
  'Project-Gifted1/register_marketplace.py',
  'Project-Gifted1/Garage-Agent-',
  'Project-Gifted1/ZeroDay-Telemetry-Gateway'
];

export const MAX_TASK_LEN = 4000;
export const MAX_PROMPT_LEN = 12000;
export const TASK_ID_RE = /^PG1-TASK-[A-Z0-9]{6}$/;

const REMOVED = '[removed]';

export function generateTaskId(bytes = randomBytes(6)) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += alphabet[bytes[i] % alphabet.length];
  return `PG1-TASK-${id}`;
}

// Returns the canonical "owner/name" for a known repo, matched
// case-insensitively by full slug or bare name, or null.
export function normalizeRepo(input) {
  if (typeof input !== 'string') return null;
  const wanted = input.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').toLowerCase();
  if (!wanted) return null;
  return KNOWN_HANDOFF_REPOS.find((r) => r.toLowerCase() === wanted || r.split('/')[1].toLowerCase() === wanted) || null;
}

// "/code repo:x402 fix the thing" or a full "Project-Gifted1/x402" slug in the
// task picks that repo. A bare name in prose ("the x402 payment") does not -
// too many pg1-ai-agent tasks mention x402 to guess from that.
export function resolveHandoffRepo(task, explicitRepo) {
  const fromArg = normalizeRepo(explicitRepo);
  if (fromArg) return { repo: fromArg, task };
  const text = typeof task === 'string' ? task : '';
  const prefix = text.match(/^\s*repo:\s*(\S+)\s*/i);
  if (prefix) {
    const repo = normalizeRepo(prefix[1]);
    if (repo) return { repo, task: text.slice(prefix[0].length) };
  }
  const slug = text.match(/\bProject-Gifted1\/[A-Za-z0-9._-]+/i);
  if (slug) {
    const repo = normalizeRepo(slug[0].replace(/[.]+$/, ''));
    if (repo) return { repo, task: text };
  }
  return { repo: DEFAULT_HANDOFF_REPO, task: text };
}

// Starting points PG1 knows for its own repo. Only pg1-ai-agent has a map;
// other repos only get files the task names explicitly.
const PG1_FILE_HINTS = [
  { file: 'public/index.html', re: /\b(ui|screen|button|drawer|card|bubble|theme|dark mode|light mode|css|style|layout|modal|composer|front-?end|mobile|render(?:s|ing)?|chip|icon)\b/i },
  { file: 'api/chat.mjs', re: /\b(chat|slash command|\/[a-z-]+ command|approv(?:e|al)|reply|replies|gemini|speak|voice|help text)\b/i },
  { file: 'api/mcp.mjs', re: /\b(mcp|tools?\/(?:list|call)|check_[a-z_]+|x402|paid tool)\b/i },
  { file: 'api/a2a.mjs', re: /\b(a2a|agent card)\b/i },
  { file: 'api/errors.mjs', re: /\berror log\b/i },
  { file: 'lib/errorLog.mjs', re: /\berror log\b/i },
  { file: 'lib/paymentGate.mjs', re: /\b(paywall|payment gate|402)\b/i },
  { file: 'lib/freeTier.mjs', re: /\b(free[- ]tier|quota)\b/i },
  { file: 'api/handoffs.mjs', re: /\b(hand-?offs?|send to code)\b/i },
  { file: 'lib/handoff.mjs', re: /\b(hand-?offs?|send to code)\b/i },
  { file: 'supabase/migrations/', re: /\b(supabase|migration|table|sql|database|rls)\b/i },
  { file: 'api/health.mjs', re: /\bhealth\b/i },
  { file: 'vercel.json', re: /\b(cron|vercel|rewrite|cors header)\b/i }
];

const FILE_PATH_RE = /(?:^|[\s`'"(\[])((?:[\w.-]+\/)*[\w-][\w.-]*\.(?:mjs|cjs|js|ts|tsx|jsx|html|css|json|sql|md|py|ya?ml|toml|txt))(?=$|[\s`'")\],:;]|\.(?:\s|$))/g;

// Resolves a name from the task (or a PG1 hint) against the repo tree:
// an exact path wins, then a unique-ish path ending in "/<name>" (shortest
// first, so "llms.txt" -> "public/llms.txt"), compared case-insensitively.
// Directory hints ("supabase/migrations/") match any path under them.
// Returns null when nothing in the tree matches.
export function resolveRepoPath(name, tree) {
  const clean = String(name || '').replace(/^\.?\//, '');
  if (!clean) return null;
  const lower = clean.toLowerCase();
  if (lower.endsWith('/')) {
    const dir = tree.find((p) => p.toLowerCase().startsWith(lower));
    return dir ? dir.slice(0, clean.length) : null;
  }
  const exact = tree.find((p) => p === clean) || tree.find((p) => p.toLowerCase() === lower);
  if (exact) return exact;
  const suffix = tree
    .filter((p) => p.toLowerCase().endsWith('/' + lower) && !/(^|\/)(node_modules|\.next)\//.test(p))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length || a.localeCompare(b));
  return suffix[0] || null;
}

// `tree` is the repo's file list (paths) when PG1 could read it from
// GitHub. With a tree, every name is resolved to a real path and names that
// match nothing are dropped; without one, names are passed through as-is.
export function findRelevantFiles(task, repo = DEFAULT_HANDOFF_REPO, limit = 8, tree = null) {
  const text = typeof task === 'string' ? task : '';
  const paths = Array.isArray(tree) && tree.length ? tree : null;
  const files = [];
  const add = (f) => {
    const real = paths ? resolveRepoPath(f, paths) : f;
    if (real && !files.includes(real) && files.length < limit) files.push(real);
  };
  for (const m of text.matchAll(FILE_PATH_RE)) add(m[1]);
  if (repo === DEFAULT_HANDOFF_REPO) {
    for (const hint of PG1_FILE_HINTS) if (hint.re.test(text)) add(hint.file);
  }
  return files;
}

// Secret patterns, most specific first. Each replaces only the secret part
// with "[removed]" and is reported to the operator by its label.
const SECRET_PATTERNS = [
  { label: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { label: 'JWT or Supabase key', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { label: 'Supabase key', re: /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{10,}/g },
  { label: 'API key', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g },
  { label: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { label: 'API key', re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { label: 'AWS key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { label: 'bearer token', re: /\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, keep: 1 },
  { label: 'credentials in a URL', re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, keep: 1, suffix: '@' },
  // NAME=value / NAME: value where NAME looks like a secret env var.
  { label: 'env value', re: /\b([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSS?|PASSWORD|PASSKEY|PAT|PRIVATE|CREDENTIALS?)\s*[=:]\s*)(["']?)[^\s"']{4,}\2/g, keep: 1 },
  // password: hunter22 / passkey = ... / api key: ... in prose. The value must
  // look like a credential (has a digit or symbol, or is long), so ordinary
  // prose after a colon is left alone.
  { label: 'password or passkey', re: /\b((?:pass(?:word|key|phrase)?|api[ _-]?key|secret|access[ _-]?token)\s*[=:]\s*)(?=\S*[0-9!@#$%^&*_+=~-]|\S{16,})[^\s"'`]{6,}/gi, keep: 1 },
  // Long random-looking blobs: 32+ chars with upper, lower and at least two
  // digits. "/" and "-" are left out of the run so file paths and repo slugs
  // never match, and hex SHAs (lowercase only) don't either.
  { label: 'long token', re: /(?<![A-Za-z0-9+_])(?=[A-Za-z0-9+_]*[A-Z])(?=[A-Za-z0-9+_]*[a-z])(?=(?:[A-Za-z+_]*[0-9]){2})[A-Za-z0-9+_]{32,}={0,2}(?![A-Za-z0-9+_])/g }
];

// The deployment's own env values that must never appear in a hand-off
// prompt. A value only counts when its variable *name* looks secret and the
// value itself is long enough to be a credential (16 chars; 6 for PASS,
// PASSKEY and PASSWORD names), so ordinary settings
// (repo names, public URLs, the app origin, flags, numbers) are never
// stripped from the task just because some env var happens to hold them.
const SECRET_ENV_NAME_RE = /(KEY|TOKEN|SECRET|PASS|PRIVATE|SERVICE_ROLE|JWT|WEBHOOK|CREDENTIAL|SALT|(?:^|_)PAT(?:_|$)|DATABASE_URL|DSN)/;
export const MIN_SECRET_ENV_LEN = 16;
// Passwords and passkeys are often short, so those names count from 6 chars.
export const MIN_PASS_ENV_LEN = 6;

export function minSecretEnvLen(name) {
  return /PASS/.test(String(name).toUpperCase()) ? MIN_PASS_ENV_LEN : MIN_SECRET_ENV_LEN;
}

function isPlainEnvValue(name, value) {
  if (/^(true|false|yes|no|on|off|null|undefined)$/i.test(value)) return true;
  if (/^[-+]?\d[\d_,.]*$/.test(value)) return true;
  if (normalizeRepo(value)) return true;
  // owner/name slugs and github.com repo links.
  if (/^(?:https?:\/\/github\.com\/)?[\w.-]+\/[\w.-]+(?:\.git)?\/?$/i.test(value)) return true;
  // A public page or origin: http(s), no credentials, no query string.
  // Webhook URLs carry their secret in the path, so those still count.
  if (!/WEBHOOK/.test(name) && /^https?:\/\/[^\s@?#]+$/i.test(value)) return true;
  return false;
}

// Returns [{ name, value }], longest value first.
export function secretEnvValues(env = process.env) {
  const values = [];
  for (const [name, raw] of Object.entries(env || {})) {
    if (!SECRET_ENV_NAME_RE.test(String(name).toUpperCase())) continue;
    const value = String(raw ?? '').trim();
    if (value.length < minSecretEnvLen(name) || isPlainEnvValue(String(name).toUpperCase(), value)) continue;
    values.push({ name, value });
  }
  return values.sort((a, b) => b.value.length - a.value.length);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Returns { text, removed } where removed is a de-duplicated list of labels
// for what was taken out. `envValues` (server only, from secretEnvValues)
// are exact { name, value } pairs to strip wherever they appear; the label
// names the variable, never the value. `placeholder` is what a secret
// becomes ("[removed]" in a hand-off; a chat reply that repeated a key
// from an image says "a key" instead, lib/visionInput.mjs).
export function stripSecrets(input, { envValues = [], placeholder = REMOVED } = {}) {
  let text = typeof input === 'string' ? input : '';
  const removed = [];
  const note = (label) => { if (!removed.includes(label)) removed.push(label); };
  for (const { name, value } of envValues || []) {
    if (!value || value.length < minSecretEnvLen(name) || !text.includes(value)) continue;
    text = text.replace(new RegExp(escapeRegExp(value), 'g'), placeholder);
    note(`value of ${name}`);
  }
  for (const { label, re, keep, suffix } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    text = text.replace(re, (...m) => {
      if (m[0] === placeholder || m[0].endsWith(placeholder)) return m[0];
      note(label);
      return (keep ? m[keep] : '') + placeholder + (suffix || '');
    });
  }
  return { text, removed };
}

export const HOUSE_RULES = [
  'Read the relevant code before changing anything.',
  'Keep runtime behaviour unchanged unless this task asks for a change.',
  'Add or update tests that cover the change.',
  'Run the full test suite (node --test tests/*.test.*). tests/preflight.test.js is a known pre-existing failure; ignore it.',
  'Open a pull request. Put the task ID {TASK_ID} in the pull request title.',
  'Stop after opening the pull request. Do not merge it.'
];

export function buildHandoffPrompt({ taskId, task, repo = DEFAULT_HANDOFF_REPO, files = [] }) {
  const lines = [];
  lines.push(`Task ID: ${taskId}`, '');
  lines.push('Task', String(task || '').trim(), '');
  lines.push('Repository', repo, '');
  if (files.length) {
    lines.push('Relevant files (starting points, not a complete list)');
    files.forEach((f) => lines.push(`- ${f}`));
    lines.push('');
  }
  lines.push('House rules');
  HOUSE_RULES.forEach((rule, i) => lines.push(`${i + 1}. ${rule.replace('{TASK_ID}', taskId)}`));
  return lines.join('\n');
}

// Stands in for the repo on the Repository line while the prompt is
// stripped; the chosen repo goes in afterwards, so stripping can never
// remove it.
const REPO_SLOT = '<repository>';

// One call for the whole draft: strips the task first (so file hints and the
// prompt never see a secret), then the finished prompt again. `tree` is the
// repo's file list, when PG1 could read it, for resolving relevant files.
export function draftHandoff({ task, repo: explicitRepo, taskId = generateTaskId(), envValues = [], tree = null }) {
  const resolved = resolveHandoffRepo(String(task || '').slice(0, MAX_TASK_LEN), explicitRepo);
  const cleanTask = stripSecrets(resolved.task, { envValues });
  const files = findRelevantFiles(cleanTask.text, resolved.repo, 8, tree);
  const built = buildHandoffPrompt({ taskId, task: cleanTask.text, repo: REPO_SLOT, files });
  const cleanPrompt = stripSecrets(built, { envValues });
  const lines = cleanPrompt.text.split('\n');
  lines[lines.lastIndexOf(REPO_SLOT)] = resolved.repo;
  const removed = [...cleanTask.removed];
  cleanPrompt.removed.forEach((l) => { if (!removed.includes(l)) removed.push(l); });
  return { taskId, repo: resolved.repo, task: cleanTask.text.trim(), files, prompt: lines.join('\n'), removed };
}

export function titleHasTaskId(title, taskId) {
  if (typeof title !== 'string' || !TASK_ID_RE.test(taskId || '')) return false;
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(taskId)}(?![A-Za-z0-9])`, 'i').test(title);
}

export function statusFromPullRequest(pr) {
  if (pr.merged_at) return 'merged';
  return pr.state === 'open' ? 'pr_open' : 'closed';
}

// The newest PR (by created_at) whose title carries the task ID decides the
// status, so a closed attempt followed by a fresh PR reads as open.
export function matchPullRequest(taskId, pulls) {
  const matches = (Array.isArray(pulls) ? pulls : []).filter((pr) => pr && titleHasTaskId(pr.title, taskId));
  if (!matches.length) return null;
  matches.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const pr = matches[0];
  return { status: statusFromPullRequest(pr), pr_url: pr.html_url || null, pr_number: pr.number ?? null };
}

// Given stored hand-off rows and recent PRs per repo, returns the rows that
// changed: [{ task_id, patch }]. Merged is final; everything else follows
// the newest matching PR. A row with no matching PR keeps its status.
export function computeHandoffUpdates(rows, pullsByRepo) {
  const updates = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.status === 'merged') continue;
    const match = matchPullRequest(row.task_id, pullsByRepo[row.repo]);
    if (!match) continue;
    if (match.status === row.status && match.pr_url === row.pr_url) continue;
    updates.push({ task_id: row.task_id, patch: match });
  }
  return updates;
}

export function isSafePrUrl(url) {
  return typeof url === 'string' && /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/\d+$/.test(url);
}
