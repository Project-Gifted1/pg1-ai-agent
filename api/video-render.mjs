// /api/video-render: renders one PG1 Motion clip synchronously, in its own
// invocation (lib/videoJobs.mjs, "Synchronous render").
//
// Since 2026-10-03 Google answers GET /v1beta/interactions/{id} with 400
// "Multiple authentication credentials received" for background
// interactions, so the chat no longer polls Google. It queues the job and
// POSTs here (dispatchVideoRender, under waitUntil); this function claims the
// job, POSTs the interaction with background: false, stores the clip in
// pg1-vault/videos/ and sets the row to done or failed. The card's status
// action only ever reads that row.
//
// Auth. Only the x-pg1-render-token header: a short-lived HMAC-SHA256 token
// over the job id, signed with PG1_VIDEO_RENDER_SECRET (or CRON_SECRET),
// checked in constant time. Sessions, cookies and the operator's password
// are never read here, so a guest or a browser can never start a render:
// anything without a valid token gets 401, before any database or engine
// call.
//
// Idempotency. The claim is one conditional UPDATE (queued -> rendering).
// A duplicate trigger finds nothing to claim, answers 200 { claimed: false }
// and never calls Google.
//
// The answer (202) goes back as soon as the job is claimed, so the
// dispatcher knows it got through; the render carries on under waitUntil in
// this same invocation, up to maxDuration.

import { waitUntil } from '@vercel/functions';
import { Agent, fetch as undiciFetch } from 'undici';
import { getSupabaseCreds } from '../lib/supabase.mjs';
import { secretEnvValues } from '../lib/handoff.mjs';
import { reportUpstreamFailure } from '../lib/upstreamFailure.mjs';
import {
  claimVideoJob, renderVideoJob, verifyRenderToken, videoEnabled, videoRenderSecret,
  VIDEO_RENDER_MAX_DURATION_S, VIDEO_RENDER_TOKEN_HEADER
} from '../lib/videoJobs.mjs';

// 800 s: the most Vercel Pro allows with Fluid compute. Must be a literal
// for Vercel's static analysis; a test holds it equal to
// VIDEO_RENDER_MAX_DURATION_S.
export const config = { maxDuration: 800 };

// Node's built-in fetch stops waiting for response headers after 300 s,
// and a synchronous render can take longer, so the render's requests go
// through an undici Agent that waits as long as the function may run.
const longAgent = new Agent({ headersTimeout: VIDEO_RENDER_MAX_DURATION_S * 1000, bodyTimeout: VIDEO_RENDER_MAX_DURATION_S * 1000 });
const longFetch = (url, options) => undiciFetch(url, { ...(options || {}), dispatcher: longAgent });

function send(res, status, body) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(body);
}

function headerValue(req, name) {
  const h = (req && req.headers) || {};
  const v = typeof h.get === 'function' ? h.get(name) : h[name] != null ? h[name] : h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function keepAlive(promise) {
  try { waitUntil(promise); } catch (e) { /* outside Vercel: nothing to extend */ }
  return promise;
}

export function geminiKeysFrom(env) {
  return [env.GEMINI_API_KEY1, env.GEMINI_API_KEY2, env.GEMINI_API_KEY].map((k) => String(k || '').replace(/\s+/g, '')).filter(Boolean);
}

export function createVideoRenderHandler({ fetchImpl = longFetch, now = () => Date.now(), sleep, log = console.log } = {}) {
  return async function handler(req, res) {
    const started = now();
    const env = process.env;
    const verdict = verifyRenderToken(headerValue(req, VIDEO_RENDER_TOKEN_HEADER), { secret: videoRenderSecret(env), now: started });
    if (!verdict.ok) return send(res, 401, { error: 'Unauthorized' });
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    if (!videoEnabled(env)) return send(res, 200, { claimed: false, reason: 'disabled' });

    let creds;
    try {
      creds = getSupabaseCreds();
    } catch (e) {
      return send(res, 503, { error: 'Storage not configured' });
    }
    const { supUrl, supKey } = creds;
    let job;
    try {
      job = await claimVideoJob({ supUrl, supKey, fetchImpl, jobId: verdict.jobId, now });
    } catch (e) {
      return send(res, 503, { error: 'Database unavailable' });
    }
    if (!job) return send(res, 200, { claimed: false });

    const work = renderVideoJob({
      env, job, geminiKeys: geminiKeysFrom(env), supUrl, supKey, fetchImpl, now, sleep, log,
      deadline: started + (VIDEO_RENDER_MAX_DURATION_S - 15) * 1000,
      onFailure: (f) => {
        reportUpstreamFailure({
          supUrl, supKey, route: 'GENERATE_VIDEO', reason: f.reason,
          status: f.status === 402 ? null : f.status, detail: f.detail,
          requestId: f.requestId || null, envValues: secretEnvValues(env)
        });
      }
    }).catch(() => ({ status: 'failed', reason: 'exception' }));
    keepAlive(work);
    send(res, 202, { claimed: true });
    return work;
  };
}

export default createVideoRenderHandler();
