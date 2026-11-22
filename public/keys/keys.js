// /keys (1.23.0): free key signup, rotation and deletion. Talks only to
// /api/keys/*. The new key is shown once in the secret-once dialog and never
// written into the page, storage or the URL.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var challengeToken = null;

  function setStatus(el, text, tone) { el.textContent = text || ''; if (tone) el.dataset.tone = tone; else delete el.dataset.tone; }

  async function post(path, body, key) {
    var headers = { 'Content-Type': 'application/json' };
    if (key) headers['X-API-KEY'] = key;
    var res = await fetch(path, { method: 'POST', headers: headers, body: JSON.stringify(body || {}), credentials: 'omit', cache: 'no-store' });
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { status: res.status, data: data || {} };
  }

  function showKey(key, title) {
    window.PG1SecretOnce.show({ value: key, title: title || 'Your free PG1 key', note: 'Copy it now: it is shown once and PG1 keeps only a hash of it. Send it in the X-API-KEY header.' });
  }

  // The bot check, only when the server has one configured.
  async function setupChallenge() {
    var box = $('challenge');
    try {
      var res = await fetch('/api/keys/signup', { credentials: 'omit', cache: 'no-store' });
      var cfg = await res.json();
      if (!cfg || !cfg.challenge_site_key) return;
      window.pg1ChallengeDone = function (token) { challengeToken = token; };
      window.pg1ChallengeExpired = function () { challengeToken = null; };
      box.classList.remove('hidden');
      box.innerHTML = '<div class="cf-turnstile" data-theme="dark" data-callback="pg1ChallengeDone" data-expired-callback="pg1ChallengeExpired"></div>';
      box.firstChild.setAttribute('data-sitekey', cfg.challenge_site_key);
      var s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
      s.async = true; s.defer = true;
      document.head.appendChild(s);
    } catch (e) { /* no bot check: the server's per-network limit applies */ }
  }

  function wireSignup() {
    var form = $('signup-form');
    var status = $('signup-status');
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var email = $('email').value.trim();
      if (!$('consent').checked) { setStatus(status, 'Tick the first box to agree to what is stored.', 'err'); return; }
      var btn = $('signup-btn');
      btn.disabled = true; setStatus(status, 'Creating your key…');
      try {
        var r = await post('/api/keys/signup', { email: email, consent: true, marketing: $('marketing').checked, challenge_token: challengeToken || undefined });
        if (r.status === 201 && r.data.key) {
          setStatus(status, 'Key created. It is shown once: copy it from the dialog.', 'ok');
          form.reset();
          showKey(r.data.key);
          r.data.key = '';
        } else {
          setStatus(status, r.data.message || 'The key could not be created. Try again.', 'err');
        }
      } catch (err) {
        setStatus(status, 'Network error. Try again.', 'err');
      } finally {
        btn.disabled = false;
        if (window.turnstile && typeof window.turnstile.reset === 'function') { try { window.turnstile.reset(); } catch (e) { /* ignore */ } challengeToken = null; }
      }
    });
  }

  function wireRotate() {
    var form = $('rotate-form');
    var status = $('rotate-status');
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var key = $('rotate-key').value.trim();
      if (!key) { setStatus(status, 'Paste your current key.', 'err'); return; }
      try {
        var r = await post('/api/keys/rotate', {}, key);
        form.reset();
        if (r.status === 200 && r.data.key) { setStatus(status, 'New key issued; the old one no longer works.', 'ok'); showKey(r.data.key, 'Your new PG1 key'); r.data.key = ''; }
        else setStatus(status, r.data.message || 'The key could not be rotated.', 'err');
      } catch (err) { setStatus(status, 'Network error. Try again.', 'err'); }
    });
  }

  function wireDelete() {
    var form = $('delete-form');
    var status = $('delete-status');
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var v = $('delete-value').value.trim();
      if (!v) { setStatus(status, 'Enter your key or your email.', 'err'); return; }
      try {
        var r = v.indexOf('@') > 0 ? await post('/api/keys/delete', { email: v }) : await post('/api/keys/delete', {}, v);
        form.reset();
        setStatus(status, r.data.message || (r.status === 200 ? 'Done.' : 'Nothing was deleted.'), r.status === 200 ? 'ok' : 'err');
      } catch (err) { setStatus(status, 'Network error. Try again.', 'err'); }
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    wireSignup(); wireRotate(); wireDelete(); setupChallenge();
  });
})();
