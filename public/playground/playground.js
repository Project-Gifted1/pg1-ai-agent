// PG1 tools playground: picks a check, posts it to /api/playground and
// renders the result card. No cookies, no storage, no analytics, no third
// parties: the only request this page makes is that POST.
//
// The card mirrors the chat's tool card (public/index.html toolCardHtml)
// and keeps PG1's rules on the client too, whatever the server sends: the
// status chip only ever says Flagged, No flags, Unknown or Failed; anything
// else is shown as Unknown; Unknown and Failed always say "unverified, not
// safe"; No flags always carries the "not an endorsement or guarantee of
// safety" caveat; the request_id is always shown.
(function () {
  'use strict';

  var STATUS_CLASS = { flagged: 'is-flagged', no_flags: 'is-clear', unknown: 'is-unknown', failed: 'is-failed' };
  var STATUS_LABEL = { flagged: 'Flagged', no_flags: 'No flags', unknown: 'Unknown', failed: 'Failed' };
  var NOTES = {
    no_flags: 'No flags means nothing was found in the sources checked. It is not an endorsement or guarantee of safety.',
    unknown: 'Unknown: this could not be fully checked. Treat it as unverified, not as safe.',
    failed: 'This check did not complete. Treat it as unverified, not as safe.',
    flagged: 'Flagged: see the reasons below.'
  };

  var TOOL_INPUTS = {
    check_domain_age: { label: 'Domain', placeholder: 'example.com', hint: 'A domain name, like example.com.', mode: 'url', chain: false },
    check_hostname_reputation: { label: 'Hostname', placeholder: 'app.example.com', hint: 'One hostname, like app.example.com. No https:// or path.', mode: 'url', chain: false },
    check_wallet_sanctions: { label: 'Wallet', placeholder: '0x… or name.eth', hint: 'An EVM address (0x followed by 40 hex characters) or an ENS name ending in .eth.', mode: 'text', chain: false },
    check_wallet_age: { label: 'Wallet', placeholder: '0x… or name.eth', hint: 'An EVM address (0x followed by 40 hex characters) or an ENS name ending in .eth.', mode: 'text', chain: true }
  };

  function escapeHTML(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function dateText(iso) {
    if (!iso || typeof iso !== 'string') return '';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
  }

  function durationText(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '';
    return ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s';
  }

  function cardStatus(card) {
    return card && Object.prototype.hasOwnProperty.call(STATUS_CLASS, card.status) ? card.status : 'unknown';
  }

  function cardHtml(card) {
    if (!card || typeof card !== 'object') return '';
    var status = cardStatus(card);
    var title = escapeHTML(card.title || String(card.tool || 'Check').replace(/_/g, ' '));
    var subjectShort = card.subject_short || card.subject || '';
    var subject = subjectShort ? '<span class="tool-card-subject" title="' + escapeHTML(card.subject || subjectShort) + '">' + escapeHTML(subjectShort) + '</span>' : '';
    var chip = '<span class="tool-chip ' + STATUS_CLASS[status] + '">' + STATUS_LABEL[status] + '</span>';
    var note = '<p class="tool-note">' + escapeHTML(NOTES[status]) + '</p>';
    var errorHtml = card.error && card.error.message ? '<p class="tool-error">' + escapeHTML(card.error.message) + '</p>' : '';
    var fields = Array.isArray(card.fields) ? card.fields.filter(function (f) { return f && f.label && f.value !== undefined && f.value !== null && f.value !== ''; }) : [];
    var fieldsHtml = fields.length
      ? '<dl class="tool-fields">' + fields.map(function (f) { return '<div class="tool-field"><dt>' + escapeHTML(f.label) + '</dt><dd>' + escapeHTML(String(f.value)) + '</dd></div>'; }).join('') + '</dl>'
      : '';
    var reasons = Array.isArray(card.reasons) ? card.reasons.filter(function (r) { return r && r.code; }) : [];
    var reasonsHtml = reasons.length
      ? '<ul class="tool-reasons" aria-label="Reasons">' + reasons.map(function (r) { return '<li><code>' + escapeHTML(r.code) + '</code> ' + escapeHTML(r.message || '') + '</li>'; }).join('') + '</ul>'
      : '';
    var checks = Array.isArray(card.checks) ? card.checks.filter(function (c) { return c && c.source; }) : [];
    var checksHtml = checks.length
      ? '<ul class="tool-checks" aria-label="Checks">' + checks.map(function (c) {
        var asOf = dateText(c.data_as_of);
        return '<li class="' + (c.result === 'ok' ? '' : 'is-incomplete') + '"><span class="tool-check-source">' + escapeHTML(c.source) + '</span><span class="tool-check-result">' + escapeHTML(c.result || '') + '</span>' + (asOf ? '<span class="tool-check-asof">data as of ' + escapeHTML(asOf) + '</span>' : '') + '</li>';
      }).join('') + '</ul>'
      : '';
    var meta = ['<span class="tool-meta-item">request_id <code>' + escapeHTML(card.request_id || 'none') + '</code></span>'];
    var dur = durationText(card.ms);
    if (dur) meta.push('<span class="tool-meta-item">' + dur + '</span>');
    if (card.test_fixture) meta.push('<span class="tool-meta-item tool-fixture">test input</span>');
    var metaHtml = '<div class="tool-meta">' + meta.join('<span aria-hidden="true">·</span>') + '</div>';
    return '<section class="tool-card ' + STATUS_CLASS[status] + '" aria-label="' + title + ' result">'
      + '<div class="tool-card-head"><span class="tool-card-title">' + title + (subject ? '<span class="tool-card-sep" aria-hidden="true"> · </span>' + subject : '') + '</span>' + chip + '</div>'
      + note + errorHtml + fieldsHtml + reasonsHtml + checksHtml + metaHtml
      + '</section>';
  }

  function messageHtml(text, requestId, isError) {
    return '<p class="pg-message' + (isError ? ' is-error' : '') + '" role="' + (isError ? 'alert' : 'status') + '">' + escapeHTML(text)
      + (requestId ? ' <span class="pg-request">request_id <code>' + escapeHTML(requestId) + '</code></span>' : '') + '</p>';
  }

  // What to show for a response from /api/playground.
  function responseHtml(status, body) {
    if (body && body.ok && body.card) return cardHtml(body.card);
    var err = body && body.error;
    var text = err && typeof err.message === 'string' && err.message ? err.message : 'The check could not be completed right now.';
    return messageHtml(text, body && body.request_id, true);
  }

  var api = { cardHtml: cardHtml, messageHtml: messageHtml, responseHtml: responseHtml, escapeHTML: escapeHTML, NOTES: NOTES, STATUS_LABEL: STATUS_LABEL, TOOL_INPUTS: TOOL_INPUTS };
  if (typeof globalThis !== 'undefined') globalThis.PG1Playground = api;

  if (typeof document === 'undefined' || !document.getElementById) return;

  function init() {
    var form = document.getElementById('pg-form');
    var input = document.getElementById('pg-input');
    var label = document.getElementById('pg-input-label');
    var hint = document.getElementById('pg-input-hint');
    var chainField = document.getElementById('pg-chain-field');
    var chain = document.getElementById('pg-chain');
    var run = document.getElementById('pg-run');
    var result = document.getElementById('pg-result');
    if (!form || !input || !result) return;

    function selectedTool() {
      var checked = form.querySelector('input[name="tool"]:checked');
      return checked ? checked.value : 'check_domain_age';
    }

    function syncTool() {
      var conf = TOOL_INPUTS[selectedTool()] || TOOL_INPUTS.check_domain_age;
      label.textContent = conf.label;
      input.placeholder = conf.placeholder;
      input.setAttribute('inputmode', conf.mode);
      hint.textContent = conf.hint;
      chainField.hidden = !conf.chain;
    }

    form.addEventListener('change', function (e) {
      if (e.target && e.target.name === 'tool') { syncTool(); result.innerHTML = ''; }
    });
    syncTool();

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var tool = selectedTool();
      var value = input.value.trim();
      if (!value) {
        result.innerHTML = messageHtml(TOOL_INPUTS[tool].hint, null, true);
        input.focus();
        return;
      }
      var payload = { tool: tool, input: value };
      if (TOOL_INPUTS[tool].chain) payload.chain = chain.value;
      run.disabled = true;
      run.textContent = 'Running…';
      result.innerHTML = messageHtml('Running the check…', null, false);
      fetch('/api/playground', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer'
      }).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (body) {
          result.innerHTML = responseHtml(res.status, body);
        });
      }).catch(function () {
        result.innerHTML = messageHtml('Could not reach PG1. Check your connection and try again.', null, true);
      }).then(function () {
        run.disabled = false;
        run.textContent = 'Run';
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
