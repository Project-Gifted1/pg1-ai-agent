// Web push to the operator's devices (the existing VAPID_PUBLIC_KEY /
// VAPID_PRIVATE_KEY pair; the page's service worker, public/sw.js, shows
// the notification). What goes out is a short title and one line, cleaned
// by notificationText: the reply secret guard (no key, token, configuration
// value or address shape), the white label (no provider or model name), no
// URLs, capped. The tap opens PG1 on the report's thread; the full report
// is fetched from PG1 behind the operator's sign-in, never sent in the push.

import { createReplySecretGuard } from '../secretGuard.mjs';
import { secretEnvValues } from '../handoff.mjs';
import { whiteLabel } from '../whiteLabel.mjs';

export const PUSH_TITLE_MAX = 60;
export const PUSH_BODY_MAX = 140;
export const DEFAULT_VAPID_SUBJECT = 'mailto:admin@project-gifted1.dev';

export function vapidKeys(env = process.env) {
  const publicKey = String(env.VAPID_PUBLIC_KEY || '').trim();
  const privateKey = String(env.VAPID_PRIVATE_KEY || '').trim();
  return publicKey && privateKey ? { publicKey, privateKey, subject: String(env.VAPID_SUBJECT || '').trim() || DEFAULT_VAPID_SUBJECT } : null;
}

// Text safe for a lock screen: no secrets, no provider names, no links,
// no wallet or key shapes, one line.
export function notificationText(text, max, env = process.env) {
  const guard = createReplySecretGuard({ envValues: secretEnvValues(env), env });
  let t = String(text == null ? '' : text)
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[`*_#>|[\]]/g, '')
    .replace(/\b0x[0-9a-fA-F]{40}\b/g, 'a wallet')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ');
  t = whiteLabel(guard(t).text);
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

// Sends one notification to every stored device (or only to `devices`,
// stored rows as store.addSubscription returns them: the menu's test
// button). Resolves to the number delivered. Never throws; never logs the
// endpoint or the payload.
export async function pushToOperator({ store, env = process.env, title, body, url = '/', tag = 'pg1-report', webpushImpl = null, devices = null }) {
  const keys = vapidKeys(env);
  if (!keys) return 0;
  let subs = [];
  if (Array.isArray(devices)) subs = devices;
  else { try { subs = await store.subscriptions(); } catch (e) { return 0; } }
  if (!subs.length) return 0;
  let webpush = webpushImpl;
  if (!webpush) {
    try { webpush = (await import('web-push')).default; } catch (e) { return 0; }
  }
  const payload = JSON.stringify({
    title: notificationText(title, PUSH_TITLE_MAX, env) || 'PG1',
    body: notificationText(body, PUSH_BODY_MAX, env),
    url: /^\/[\w\-/?=&.%]*$/.test(String(url)) ? String(url).slice(0, 300) : '/',
    tag: String(tag).replace(/[^\w:-]/g, '').slice(0, 64) || 'pg1-report'
  });
  let sent = 0;
  for (const sub of subs) {
    let outcome = 'failed';
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 24 * 3600, urgency: 'normal', vapidDetails: { subject: keys.subject, publicKey: keys.publicKey, privateKey: keys.privateKey } });
      outcome = 'ok';
      sent++;
    } catch (e) {
      outcome = e && (e.statusCode === 404 || e.statusCode === 410) ? 'gone' : 'failed';
      console.warn(`[watches] push_failed status=${(e && e.statusCode) || '-'}`);
    }
    try { await store.subscriptionResult(sub, outcome); } catch (e) { /* bookkeeping only */ }
  }
  return sent;
}
