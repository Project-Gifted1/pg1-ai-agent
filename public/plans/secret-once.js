// A secret shown once (1.23.0): the same dialog as the operator app's
// showSecretOnce (public/index.html), for public pages. A dialog with a
// partly hidden preview and a Copy button; closing it removes the dialog and
// drops the value from the page.
(function () {
  'use strict';
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function showSecretOnce(once, onClose) {
    if (!once || typeof once.value !== 'string') return null;
    var value = once.value;
    var old = document.getElementById('secret-once');
    if (old) old.remove();
    var dlg = document.createElement('dialog');
    dlg.className = 'secret-once'; dlg.id = 'secret-once';
    dlg.setAttribute('aria-labelledby', 'secret-once-h');
    dlg.innerHTML = '<h3 id="secret-once-h">' + esc(once.title || 'Shown once') + '</h3><p>' + esc(once.note || 'Copy it now; it will not be shown again.') + '</p><p class="secret-once-mask" aria-label="Key, partly hidden">' + esc(value.slice(0, 8)) + '••••••••</p><div class="secret-once-actions"><button type="button" class="btn" data-act="copy">Copy key</button><button type="button" class="btn ghost" data-act="close">Close</button></div><p class="secret-once-status" role="status"></p>';
    var status = dlg.querySelector('.secret-once-status');
    dlg.querySelector('[data-act="copy"]').onclick = function () {
      var done = function () { status.textContent = 'Copied. Close this when you have saved it.'; };
      var blocked = function () { status.textContent = 'Copying is blocked in this browser.'; };
      try { navigator.clipboard.writeText(value).then(done, blocked); } catch (e) { blocked(); }
    };
    var close = function () { value = ''; try { dlg.close(); } catch (e) { /* closed */ } dlg.remove(); if (onClose) onClose(); };
    dlg.querySelector('[data-act="close"]').onclick = close;
    dlg.addEventListener('cancel', function (e) { e.preventDefault(); close(); });
    document.body.appendChild(dlg);
    try { dlg.showModal(); } catch (e) { dlg.setAttribute('open', ''); }
    return dlg;
  }
  window.PG1SecretOnce = { show: showSecretOnce };
})();
