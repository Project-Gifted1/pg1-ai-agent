// /api/handoffs: Send to Code hand-offs (lib/handoff.mjs). Operator only,
// same USER_API_KEY/USER_API_PASS check and POST-with-an-op shape as
// api/errors.mjs.
//
//   { op: 'draft', user, pass, task, repo? }
//     Builds the task prompt (no model call), resolves relevant file names
//     against the repo tree (read with PG1's existing GITHUB_TOKEN), strips
//     anything that looks like a secret, stores a 'drafted' row in pg1_handoffs and returns the
//     prompt for the chat card. Storage failing never blocks the draft.
//   { op: 'sent', user, pass, taskId, prompt }
//     The operator copied the (possibly edited) prompt: re-strip it, store
//     it, and move drafted -> sent.
//   { op: 'list', user, pass }
//     Newest hand-offs for the drawer. Also syncs status from GitHub using
//     PG1's existing GITHUB_TOKEN (the same one api/chat.mjs uses): the
//     newest PR whose title carries the task ID sets pr_open/merged/closed.
//
// Hand-off PRs are never routed through the in-app Approve flow
// (pending_actions); the drawer links straight to GitHub.

import { safeCompare } from './chat.mjs';
import { getSupabaseCreds } from '../lib/supabase.mjs';
import {
  draftHandoff, stripSecrets, secretEnvValues, computeHandoffUpdates,
  isSafePrUrl, resolveHandoffRepo, TASK_ID_RE, MAX_PROMPT_LEN, MAX_TASK_LEN, KNOWN_HANDOFF_REPOS
} from '../lib/handoff.mjs';

export const config = { maxDuration: 15 };

const LIST_LIMIT = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 30;
const TABLE = 'pg1_handoffs';

var requestsByIp = new Map();

export function __clearHandoffsRateLimitState() {
  requestsByIp.clear();
}

function isRateLimited(ip) {
  var now = Date.now();
  var entry = requestsByIp.get(ip);
  if (!entry || (entry.windowStart + RATE_LIMIT_WINDOW_MS) < now) {
    requestsByIp.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

function getClientIp(req) {
  var forwardedFor = req.headers && req.headers['x-forwarded-for'];
  if (forwardedFor) {
    var first = String(forwardedFor).split(',')[0].trim();
    if (first) return first;
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function isAuthedRequest(user, pass) {
  var expectedUser = (process.env.USER_API_KEY || process.env.USER_API_USER || '').trim();
  var expectedPass = (process.env.USER_API_PASS || process.env.USER_API_PASSS || '').trim();
  return !!(expectedUser && expectedPass && safeCompare(user, expectedUser) && safeCompare(pass, expectedPass));
}

function supabaseOrNull() {
  try {
    var creds = getSupabaseCreds();
    return { url: creds.supUrl, headers: { apikey: creds.supKey, Authorization: `Bearer ${creds.supKey}` } };
  } catch (e) {
    return null;
  }
}

async function fetchPullsByRepo(repos, githubToken) {
  var ghHeaders = {
    'Authorization': `Bearer ${githubToken}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'Sovereign-Agent',
    'Cache-Control': 'no-cache'
  };
  var pullsByRepo = {};
  var failed = false;
  for (var i = 0; i < repos.length; i++) {
    var repo = repos[i];
    try {
      var r = await fetch(`https://api.github.com/repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=100`, { headers: ghHeaders, cache: 'no-store' });
      if (!r.ok) { failed = true; continue; }
      pullsByRepo[repo] = await r.json();
    } catch (e) {
      failed = true;
    }
  }
  return { pullsByRepo, failed };
}

const TREE_TIMEOUT_MS = 5000;

// The repo's file and directory paths from the default branch, or null when
// GitHub can't be reached (the draft then keeps file names unresolved).
async function fetchRepoTree(repo, githubToken) {
  if (!githubToken || !KNOWN_HANDOFF_REPOS.includes(repo)) return null;
  try {
    var r = await fetch(`https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`, {
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'Sovereign-Agent'
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(TREE_TIMEOUT_MS)
    });
    if (!r.ok) return null;
    var data = await r.json();
    if (!data || !Array.isArray(data.tree)) return null;
    var paths = data.tree
      .filter((item) => item && typeof item.path === 'string')
      .map((item) => item.type === 'tree' ? item.path + '/' : item.path);
    return paths.length ? paths : null;
  } catch (e) {
    return null;
  }
}

async function patchRow(db, taskId, patch, extraFilter) {
  return fetch(`${db.url}/rest/v1/${TABLE}?task_id=eq.${encodeURIComponent(taskId)}${extraFilter || ''}`, {
    method: 'PATCH',
    headers: { ...db.headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
  });
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (isRateLimited(getClientIp(req))) {
    return res.status(429).json({ error: 'Too many requests, please slow down.' });
  }

  var body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  if (!isAuthedRequest(body.user, body.pass)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  var op = body.op;
  var envValues = secretEnvValues(process.env);
  var db = supabaseOrNull();

  if (op === 'draft') {
    var task = typeof body.task === 'string' ? body.task.trim() : '';
    if (!task) return res.status(400).json({ error: 'Missing task' });
    var draftRepo = resolveHandoffRepo(task.slice(0, MAX_TASK_LEN), body.repo).repo;
    var tree = await fetchRepoTree(draftRepo, (process.env.GITHUB_TOKEN || '').replace(/\s+/g, ''));
    var draft = draftHandoff({ task: task, repo: body.repo, envValues: envValues, tree: tree });
    var stored = false;
    if (db) {
      try {
        var insertRes = await fetch(`${db.url}/rest/v1/${TABLE}`, {
          method: 'POST',
          headers: { ...db.headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ task_id: draft.taskId, repo: draft.repo, task: draft.task, prompt: draft.prompt, status: 'drafted' })
        });
        stored = insertRes.ok;
      } catch (e) {
        stored = false;
      }
    }
    return res.status(200).json({ ok: true, stored: stored, ...draft });
  }

  if (op === 'sent') {
    var taskId = typeof body.taskId === 'string' ? body.taskId : '';
    if (!TASK_ID_RE.test(taskId)) return res.status(400).json({ error: 'Invalid taskId' });
    var cleaned = stripSecrets(String(body.prompt || '').slice(0, MAX_PROMPT_LEN), { envValues: envValues });
    if (!db) return res.status(200).json({ ok: true, stored: false, removed: cleaned.removed });
    try {
      // Only drafted/sent rows move to sent; a row GitHub already moved on
      // (pr_open/merged/closed) keeps its status, but the prompt is updated.
      var r1 = await patchRow(db, taskId, { status: 'sent', prompt: cleaned.text }, '&status=in.(drafted,sent)');
      var r2 = await patchRow(db, taskId, { prompt: cleaned.text }, '&status=not.in.(drafted,sent)');
      return res.status(200).json({ ok: true, stored: r1.ok && r2.ok, removed: cleaned.removed });
    } catch (e) {
      return res.status(200).json({ ok: true, stored: false, removed: cleaned.removed });
    }
  }

  if (op === 'list') {
    if (!db) return res.status(503).json({ error: 'Hand-off storage not configured on this deployment.' });
    var rows;
    try {
      var listRes = await fetch(`${db.url}/rest/v1/${TABLE}?select=task_id,created_at,repo,task,status,pr_url,pr_number&order=created_at.desc&limit=${LIST_LIMIT}`, { headers: db.headers });
      if (!listRes.ok) return res.status(502).json({ error: 'Could not read hand-offs.' });
      rows = await listRes.json();
      if (!Array.isArray(rows)) rows = [];
    } catch (e) {
      return res.status(502).json({ error: 'Could not read hand-offs.' });
    }

    var githubToken = (process.env.GITHUB_TOKEN || '').replace(/\s+/g, '');
    var sync = { synced: false };
    if (!githubToken) {
      sync.syncError = 'GitHub access is not configured on this deployment.';
    } else {
      var repos = [...new Set(rows.filter((r) => r.status !== 'merged').map((r) => r.repo))]
        .filter((r) => KNOWN_HANDOFF_REPOS.includes(r));
      var fetched = await fetchPullsByRepo(repos, githubToken);
      var updates = computeHandoffUpdates(rows, fetched.pullsByRepo);
      for (var i = 0; i < updates.length; i++) {
        var u = updates[i];
        try { await patchRow(db, u.task_id, u.patch); } catch (e) { /* shown below anyway; next list retries */ }
        var row = rows.find((r) => r.task_id === u.task_id);
        if (row) Object.assign(row, u.patch);
      }
      sync.synced = !fetched.failed;
      if (fetched.failed) sync.syncError = 'Could not reach GitHub for some repos.';
    }

    var handoffs = rows.map((r) => ({
      task_id: r.task_id,
      created_at: r.created_at,
      repo: r.repo,
      task: typeof r.task === 'string' ? r.task.slice(0, 200) : '',
      status: r.status,
      pr_url: isSafePrUrl(r.pr_url) ? r.pr_url : null
    }));
    return res.status(200).json({ ok: true, handoffs: handoffs, ...sync });
  }

  return res.status(400).json({ error: `Unknown op '${op}'` });
}
