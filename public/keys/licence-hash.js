// The licence hash page: sha256 of the trimmed licence key, in this browser
// only (crypto.subtle). Nothing is sent, stored or logged; the field is
// cleared once the hash is shown.
(function () {
  'use strict';
  document.addEventListener('DOMContentLoaded', function () {
    var form = document.getElementById('hash-form');
    var input = document.getElementById('licence');
    var out = document.getElementById('hash-out');
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var key = input.value.trim();
      input.value = '';
      if (!key) { out.textContent = 'Paste the licence key first.'; return; }
      var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
      key = '';
      out.textContent = Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
      out.dataset.tone = 'ok';
    });
  });
})();
