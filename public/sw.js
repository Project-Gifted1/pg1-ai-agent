// PG1 service worker: web push only (lib/watches/push.mjs). No caching, no
// fetch handling. A push carries a short title and one line, already
// cleaned on the server (no keys, no provider names, no links); tapping it
// focuses PG1 (or opens it) on the report's thread, where the full report
// is fetched after sign-in.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const title = String(data.title || 'PG1').slice(0, 60);
  const url = /^\/[\w\-/?=&.%]*$/.test(String(data.url || '')) ? String(data.url) : '/';
  event.waitUntil(self.registration.showNotification(title, {
    body: String(data.body || '').slice(0, 140),
    tag: String(data.tag || 'pg1-report').slice(0, 64),
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    data: { url }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find((c) => new URL(c.url).origin === self.location.origin);
    if (open) {
      open.postMessage({ type: 'pg1-report', url });
      return open.focus();
    }
    return self.clients.openWindow(url);
  })());
});
