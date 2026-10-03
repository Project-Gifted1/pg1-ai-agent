// PG1 integration guides: a copy button on each code block. Loaded as a
// file because the page's Content-Security-Policy allows no inline
// scripts. No network requests, no cookies, no storage.
'use strict';

(function () {
  function fallbackCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'copy-buffer';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(area);
    return ok ? Promise.resolve() : Promise.reject(new Error('copy failed'));
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () { return fallbackCopy(text); });
    }
    return fallbackCopy(text);
  }

  function flash(button, label, cls) {
    button.textContent = label;
    if (cls) button.classList.add(cls);
    clearTimeout(button._resetTimer);
    button._resetTimer = setTimeout(function () {
      button.textContent = 'Copy';
      button.classList.remove('is-done');
    }, 2000);
  }

  function init() {
    var buttons = document.querySelectorAll('[data-copy]');
    Array.prototype.forEach.call(buttons, function (button) {
      var block = button.closest('.code');
      var code = block && block.querySelector('pre code');
      if (!code) return;
      button.setAttribute('aria-label', 'Copy code');
      button.setAttribute('aria-live', 'polite');
      button.hidden = false;
      button.addEventListener('click', function () {
        copyText(code.textContent).then(
          function () { flash(button, 'Copied', 'is-done'); },
          function () { flash(button, 'Press Ctrl+C'); selectCode(code); }
        );
      });
    });
  }

  function selectCode(code) {
    var range = document.createRange();
    range.selectNodeContents(code);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
