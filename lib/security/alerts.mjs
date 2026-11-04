// Sign-in alerts to the operator's phone (web push, lib/watches/push.mjs):
//   - every new operator sign-in (a new session: password, passkey or the
//     recovery switch), and
//   - a burst of failed attempts: BURST_FAILURES or more in BURST_WINDOW_MS,
//     at most one alert per window (recorded as a 'burst_alert' event, so
//     every instance sees it was sent).
// What a notification says: the device type and a rough time, nothing
// else. Never an IP address (not even part of one), a user agent string,
// a credential or a location.

import { pushToOperator } from '../watches/push.mjs';
import { createWatchStore } from '../watches/store.mjs';
import { getSupabaseCreds } from '../supabase.mjs';
import { USAGE_TIME_ZONE } from '../usageStats.mjs';

export const BURST_FAILURES = 5;
export const BURST_WINDOW_MS = 10 * 60 * 1000;

function headerOf(req, name) {
  const h = req && req.headers;
  if (!h) return '';
  const v = typeof h.get === 'function' ? h.get(name) : h[name];
  return typeof v === 'string' ? v : '';
}

// A device type from the user agent (and the client hint when present):
// a few fixed words, never the string itself.
export function deviceType(reqOrUa) {
  const ua = typeof reqOrUa === 'string' ? reqOrUa : headerOf(reqOrUa, 'user-agent');
  const hintPlatform = typeof reqOrUa === 'string' ? '' : headerOf(reqOrUa, 'sec-ch-ua-platform').replace(/"/g, '');
  const hintMobile = typeof reqOrUa === 'string' ? '' : headerOf(reqOrUa, 'sec-ch-ua-mobile');
  const s = String(ua || '');
  if (/iPhone/i.test(s)) return 'iPhone';
  if (/iPad/i.test(s)) return 'iPad';
  if (/Android/i.test(s) || /^android$/i.test(hintPlatform)) return /Mobile/i.test(s) || hintMobile === '?1' ? 'Android phone' : 'Android tablet';
  if (/CrOS/i.test(s) || /^chrome os$/i.test(hintPlatform)) return 'Chromebook';
  if (/Windows/i.test(s) || /^windows$/i.test(hintPlatform)) return 'Windows computer';
  if (/Macintosh|Mac OS X/i.test(s) || /^macos$/i.test(hintPlatform)) return 'Mac';
  if (/Linux/i.test(s) || /^linux$/i.test(hintPlatform)) return 'Linux computer';
  if (/curl|wget|python|node|go-http|okhttp|axios|bot/i.test(s)) return 'script or bot';
  return 'unknown device';
}

// The time to the quarter hour, in the operator's zone (the one the usage
// reports use): "about 14:30".
export function roughTime(nowMs = Date.now(), timeZone = USAGE_TIME_ZONE) {
  const q = Math.round(nowMs / (15 * 60000)) * 15 * 60000;
  const t = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(q));
  return `about ${t}`;
}

const METHOD_WORDS = { passkey: 'with a passkey', password: 'with the password', recovery: 'with the password (recovery switch on)' };

export function signInAlertText({ method, device, nowMs = Date.now() }) {
  return {
    title: 'New PG1 sign-in',
    body: `Signed in ${METHOD_WORDS[method] || ''} on ${/^[aeiou]/i.test(device) ? 'an' : 'a'} ${device}, ${roughTime(nowMs)}. Not you? Send /security signout-all.`.replace(/\s+/g, ' ')
  };
}

export function burstAlertText({ count, device, nowMs = Date.now() }) {
  return {
    title: 'Failed PG1 sign-ins',
    body: `${count >= BURST_FAILURES * 2 ? `${count}+` : count} failed sign-in attempts in 10 minutes, the latest from ${/^[aeiou]/i.test(device) ? 'an' : 'a'} ${device}, ${roughTime(nowMs)}.`
  };
}

// The deployment's push: every subscribed device. Resolves to the number
// delivered; never throws.
export function defaultSecurityPush({ env = process.env, webpushImpl = null, fetchImpl } = {}) {
  return async ({ title, body, tag }) => {
    let creds;
    try { creds = getSupabaseCreds(); } catch (e) { return 0; }
    try {
      return await pushToOperator({ store: createWatchStore({ ...creds, ...(fetchImpl ? { fetchImpl } : {}) }), env, title, body, url: '/', tag, webpushImpl });
    } catch (e) { return 0; }
  };
}

export async function alertSignIn({ push, method, device, nowMs = Date.now() }) {
  if (typeof push !== 'function') return 0;
  try { return await push({ ...signInAlertText({ method, device, nowMs }), tag: 'pg1-signin' }); } catch (e) { return 0; }
}

// Called after a failed attempt is recorded. Sends the burst alert when the
// last 10 minutes hold BURST_FAILURES or more failures and none was sent
// in that window. Resolves to true when it sent one.
export async function maybeAlertBurst({ store, push, device, nowMs = Date.now() }) {
  if (typeof push !== 'function') return false;
  try {
    const since = nowMs - BURST_WINDOW_MS;
    const count = await store.countEvents({ kind: 'failure', sinceMs: since, limit: BURST_FAILURES * 2 });
    if (count < BURST_FAILURES) return false;
    const sent = await store.countEvents({ kind: 'burst_alert', sinceMs: since, limit: 1 });
    if (sent > 0) return false;
    await store.addEvent({ kind: 'burst_alert', ip_hash: null, method: null, device: null, created_at: new Date(nowMs).toISOString() });
    await push({ ...burstAlertText({ count, device, nowMs }), tag: 'pg1-signin-failures' });
    return true;
  } catch (e) {
    return false;
  }
}
