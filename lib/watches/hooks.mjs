// The three event routes (api/hooks/github.mjs, api/hooks/vercel.mjs,
// api/hooks/lab.mjs) as handler factories, so tests can pass their own
// clock, sleep and waitUntil. The routes export them as Web handlers
// (asWebHandler) so the signature is checked over the exact bytes sent.
//
// Every route: POST only; the raw body is verified first (lib/watches/
// signatures.mjs) and an unsigned, wrongly signed or unconfigured event is
// refused (401, or 503 when the secret is not set) with one log line that
// names the source and the reason only, never the payload. A verified
// event updates the matching watch (lib/watches/engine.mjs); events about
// things nobody watches are acknowledged and dropped.

import { readRawBody, MAX_HOOK_BODY_BYTES, verifyGithubSignature, verifyVercelSignature, verifyLabCallback, logRejection, hookHeader } from './signatures.mjs';
import { fromGithubEvent, fromVercelEvent, readPr } from './sources.mjs';
import { createWatchStore } from './store.mjs';
import { onTargetState, readLab, autoWatch } from './engine.mjs';
import { getSupabaseCreds } from '../supabase.mjs';
import { isTerminal } from './targets.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function send(res, status, body) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(body);
}

// Verifies and parses. Resolves to { payload } or sends the refusal and
// resolves to null.
async function verified(req, res, source, verify, env) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: 'Method Not Allowed' }) && null;
  }
  let raw;
  try {
    raw = await readRawBody(req);
  } catch (e) {
    logRejection(source, e && e.tooLarge ? 'too_large' : 'unreadable');
    return send(res, e && e.tooLarge ? 413 : 400, { error: 'unreadable body' }) && null;
  }
  const v = verify(req, raw, env);
  if (!v.ok) {
    logRejection(source, v.reason);
    return send(res, v.reason === 'not_configured' ? 503 : 401, { error: v.reason === 'not_configured' ? 'not configured' : 'invalid signature' }) && null;
  }
  try {
    const payload = JSON.parse(raw.toString('utf8'));
    if (!payload || typeof payload !== 'object') throw new Error('not an object');
    return { payload };
  } catch (e) {
    logRejection(source, 'bad_json');
    return send(res, 400, { error: 'invalid JSON' }) && null;
  }
}

// A route that exports POST(request) instead of a default (req, res)
// handler is run by Vercel without its Node helpers, which would otherwise
// read and JSON-parse the body first (losing the bytes the sender signed).
// This wraps a (req, res) hook handler as such a POST: the body is taken
// from request.arrayBuffer() unchanged and handed over as req.rawBody, and
// the res the handler writes becomes the Response.
export function asWebHandler(handler, { maxBytes = MAX_HOOK_BODY_BYTES } = {}) {
  return async function webHook(request) {
    const out = { status: 200, headers: new Headers(), body: null };
    const res = {
      setHeader(k, v) { out.headers.set(k, String(v)); return res; },
      status(code) { out.status = code; return res; },
      json(b) { out.body = JSON.stringify(b); return res; }
    };
    const req = { method: request.method, headers: request.headers, rawBody: null };
    if (request.method === 'POST') {
      if (Number(request.headers.get('content-length')) > maxBytes) {
        req.rawBody = Buffer.alloc(maxBytes + 1);
      } else {
        try { req.rawBody = Buffer.from(await request.arrayBuffer()); } catch (e) { req.rawBody = null; }
      }
    }
    await handler(req, res);
    return new Response(out.body, { status: out.status, headers: out.headers });
  };
}

function storage(fetchImpl) {
  const { supUrl, supKey } = getSupabaseCreds();
  return { supUrl, supKey, store: createWatchStore({ supUrl, supKey, fetchImpl }) };
}

export function createGithubHookHandler({ env = process.env, fetchImpl = (u, o) => globalThis.fetch(u, o), now = () => Date.now(), webpushImpl = null } = {}) {
  return async function githubHook(req, res) {
    const got = await verified(req, res, 'github', verifyGithubSignature, env);
    if (!got) return;
    const event = hookHeader(req, 'x-github-event').trim();
    if (event === 'ping') return send(res, 200, { ok: true, pong: true });
    const parsed = fromGithubEvent(event, got.payload);
    if (!parsed.items.length && !parsed.labId) return send(res, 200, { ok: true, handled: 0 });
    let s;
    try { s = storage(fetchImpl); } catch (e) { return send(res, 503, { error: 'storage not configured' }); }
    const deps = { env, supUrl: s.supUrl, supKey: s.supKey, fetchImpl, now: now(), webpushImpl };
    let handled = 0;
    let reported = 0;
    try {
      // A lab run finished: sync the experiment now (reads its result
      // artifact) and report it if watched.
      if (parsed.labId) {
        const snap = await readLab(parsed.labId, deps).catch(() => null);
        if (snap) {
          const r = await onTargetState({ ...deps, store: s.store, type: 'lab', id: snap.info.exp.id, snapshot: snap });
          handled++; if (r.reported) reported++;
        }
      }
      for (const item of parsed.items) {
        if (!(await s.store.openFor(item.type, item.id))) continue;
        // A check suite finished: the PR's overall CI, read back, beats
        // one suite's own conclusion.
        const snapshot = item.needsCi ? ((await readPr(item.id, deps).catch(() => null)) || item.snapshot) : item.snapshot;
        if (!snapshot) continue;
        const r = await onTargetState({ ...deps, store: s.store, type: item.type, id: item.id, snapshot });
        handled++; if (r.reported) reported++;
      }
    } catch (e) {
      console.error(`[hooks] github_failed event=${event.replace(/[^a-z_]/g, '').slice(0, 30)} ${e && e.status ? `status=${e.status}` : 'error'}`);
      return send(res, 500, { error: 'not processed' });
    }
    return send(res, 200, { ok: true, handled, reported });
  };
}

export function createVercelHookHandler({ env = process.env, fetchImpl = (u, o) => globalThis.fetch(u, o), now = () => Date.now(), webpushImpl = null } = {}) {
  return async function vercelHook(req, res) {
    const got = await verified(req, res, 'vercel', verifyVercelSignature, env);
    if (!got) return;
    const ev = fromVercelEvent(got.payload);
    if (!ev) return send(res, 200, { ok: true, handled: 0 });
    let s;
    try { s = storage(fetchImpl); } catch (e) { return send(res, 503, { error: 'storage not configured' }); }
    const deps = { env, supUrl: s.supUrl, supKey: s.supKey, fetchImpl, now: now(), webpushImpl };
    try {
      // Production deploys are watched automatically (the autonomy policy
      // decides; with PG1_AUTONOMY=off nothing is watched).
      if (ev.production) {
        await autoWatch({ ...deps, store: s.store, type: 'deploy', id: ev.id, label: `Production deploy${ev.snapshot.info.project ? ` of ${ev.snapshot.info.project}` : ''}`, lastState: isTerminal('deploy', ev.snapshot.state) ? null : ev.snapshot.state });
      }
      const r = await onTargetState({ ...deps, store: s.store, type: 'deploy', id: ev.id, snapshot: ev.snapshot });
      return send(res, 200, { ok: true, handled: r.watched ? 1 : 0, reported: r.reported ? 1 : 0 });
    } catch (e) {
      console.error(`[hooks] vercel_failed ${e && e.status ? `status=${e.status}` : 'error'}`);
      return send(res, 500, { error: 'not processed' });
    }
  };
}

// The lab runner's last job posts { experiment_id, run_id, conclusion }
// while its own run is still finishing, so the sync runs after the answer
// (waitUntil), retrying until GitHub shows the run completed. The
// workflow_run webhook is the second, independent signal.
export const LAB_HOOK_ATTEMPTS = 6;
export const LAB_HOOK_DELAY_MS = 8000;

export function createLabHookHandler({ env = process.env, fetchImpl = (u, o) => globalThis.fetch(u, o), now = () => Date.now(), webpushImpl = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), waitUntil = null, attempts = LAB_HOOK_ATTEMPTS, delayMs = LAB_HOOK_DELAY_MS } = {}) {
  return async function labHook(req, res) {
    const got = await verified(req, res, 'lab', (r, raw, e) => verifyLabCallback(r, raw, e, Math.floor(now() / 1000)), env);
    if (!got) return;
    const id = String(got.payload.experiment_id || '').toLowerCase();
    if (!UUID_RE.test(id)) {
      logRejection('lab', 'bad_id');
      return send(res, 400, { error: 'experiment_id must be a uuid' });
    }
    let s;
    try { s = storage(fetchImpl); } catch (e) { return send(res, 503, { error: 'storage not configured' }); }
    const work = (async () => {
      for (let i = 0; i < attempts; i++) {
        if (i) await sleep(delayMs);
        const deps = { env, supUrl: s.supUrl, supKey: s.supKey, fetchImpl, now: now(), webpushImpl };
        const snap = await readLab(id, deps).catch(() => null);
        if (!snap) return { status: 'unknown' };
        if (isTerminal('lab', snap.state)) {
          const r = await onTargetState({ ...deps, store: s.store, type: 'lab', id, snapshot: snap }).catch(() => ({ reported: false }));
          return { status: snap.state, reported: !!r.reported };
        }
      }
      return { status: 'running' };
    })().catch((e) => {
      console.error(`[hooks] lab_sync_failed ${e && e.status ? `status=${e.status}` : 'error'}`);
      return { status: 'error' };
    });
    if (waitUntil) {
      try { waitUntil(work); } catch (e) { /* outside Vercel the promise still runs */ }
      return send(res, 202, { ok: true, accepted: true });
    }
    const out = await work;
    return send(res, 200, { ok: true, ...out });
  };
}
