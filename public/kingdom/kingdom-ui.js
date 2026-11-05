// PG1 Kingdom Defence in the Command Centre: the full-screen view (the 3D
// scene, a caption, the legend and a text feed of the same events) and the
// compact live mini-view in the thread feed.
//
//   createKingdomUi({ creds, fetchImpl, doc }) -> { open(), close(), startMini(), stopMini(), isOpen() }
//
// Data: /api/defense-feed, signed-in operator only (the credentials go in
// the POST body, like /api/home-context; never the query string). The full
// 24 h once when the view opens, then a poll every 5 s while it is open and
// the tab is visible. The mini-view polls every 30 s while the page is
// visible and the full view is closed, and hides itself when there is
// nothing to show or the caller is not the operator.
//
// Only real events are drawn: when the view opens, only the events of the
// last few minutes are staged as figures (the rest of the day is in the
// text feed and the counts); afterwards each poll stages what is new.

import { createEventStore, eventLine, dublinTime, verdictText, reasonLabel, replaySchedule, GADGET_META } from './kingdom-data.js';

export const KINGDOM_POLL_MS = 5000;
export const MINI_POLL_MS = 30000;
export const STAGE_RECENT_MS = 3 * 60 * 1000;
export const FEED_ROWS = 200;
const POLL_OVERLAP_MS = 70 * 1000;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function feedRowHtml(e) {
  const reason = e.reasons.length ? ` · ${esc(reasonLabel(e.reasons[0]))}` : '';
  const where = e.role === 'kingdom' ? 'PG1' : e.country || (e.check === 'operator_signin' ? '—' : 'fog');
  return `<li class="kd-row" data-role="${esc(e.role)}" data-sev="${esc(e.severity)}" data-id="${esc(e.id)}">`
    + `<time datetime="${new Date(e.time).toISOString()}">${esc(dublinTime(e.time))}</time>`
    + `<span class="kd-cc" aria-label="${e.country ? `country ${esc(e.country)}` : esc(where)}">${esc(where)}</span>`
    + `<span class="kd-what"><strong>${esc((GADGET_META[e.gadget] || {}).name || e.gadget)}</strong> · ${esc(e.check)} · ${esc(verdictText(e))}${reason}${e.caller ? ` · <code>${esc(e.caller)}</code>` : ''}</span>`
    + `<span class="kd-n">${e.count > 1 ? `×${e.count}` : ''}</span></li>`;
}

export function legendHtml(gadgets, today) {
  return gadgets.map((g) => `<li data-gadget="${esc(g.id)}"${g.reserved ? ' data-reserved="true"' : ''}><span class="kd-dot" style="background:#${((GADGET_META[g.id] || {}).color || 0x888888).toString(16).padStart(6, '0')}"></span><span class="kd-gname">${esc(g.name)}</span><span class="kd-gcheck">${esc(g.check)}${g.reserved ? ' · idle until its data exists' : ''}</span><span class="kd-gcount">${Number(today[g.id] || 0)}</span></li>`).join('');
}

export function createKingdomUi({ creds, fetchImpl = (...a) => fetch(...a), doc = document } = {}) {
  const $ = (id) => doc.getElementById(id);
  const store = createEventStore();
  let scene = null; let open = false; let pollTimer = null; let miniTimer = null; let lastAt = 0; let gadgets = []; let opening = null;
  let recording = null; let replaying = false; let replayTimers = []; let clipUrl = null;

  async function fetchFeed(since) {
    const c = creds();
    if (!c || !c.user || !c.pass) return null;
    const url = since ? `/api/defense-feed?since=${Math.floor(since)}` : '/api/defense-feed';
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: c.user, pass: c.pass }) });
      if (!res.ok) return null;
      const data = await res.json();
      return data && data.ok ? data : null;
    } catch (e) { return null; }
  }

  function renderSide() {
    const list = store.list();
    const feed = $('kingdom-feed');
    if (feed) feed.innerHTML = list.length ? list.slice(0, FEED_ROWS).map(feedRowHtml).join('') : '<li class="kd-empty">No defence events in the last 24 hours. The kingdom is calm.</li>';
    const legend = $('kingdom-legend');
    if (legend && gadgets.length) legend.innerHTML = legendHtml(gadgets, store.today);
    const level = store.threat.level;
    const mode = $('kingdom-mode');
    if (mode) { mode.dataset.mode = level; mode.textContent = level === 'storm' ? 'Under attack' : level === 'watch' ? 'On watch' : 'Calm'; }
    const sum = $('kingdom-summary');
    const attackers = list.filter((e) => e.role === 'attacker').reduce((n, e) => n + e.count, 0);
    if (sum) sum.textContent = `${level === 'storm' ? 'Under attack' : level === 'watch' ? 'On watch' : 'Calm'}: ${list.length} defence events in the last 24 hours, ${attackers} turned away or flagged.`;
  }

  function setCaption(e) {
    const cap = $('kingdom-caption');
    if (!cap) return;
    cap.textContent = e ? eventLine(e) : '';
    cap.hidden = !e;
  }

  function apply(feed, { initial = false } = {}) {
    if (Array.isArray(feed.gadgets)) gadgets = feed.gadgets.filter((g) => g && typeof g.id === 'string' && Object.hasOwn(GADGET_META, g.id)).map((g) => ({ id: g.id, name: String(g.name || g.id).slice(0, 40), check: String(g.check || '').slice(0, 60), reserved: !!g.reserved }));
    const { fresh, level } = store.merge(feed);
    const gen = Date.parse(feed.generated_at);
    if (Number.isFinite(gen)) lastAt = gen;
    if (scene) {
      scene.setThreat(level);
      scene.setToday(store.today);
      const stage = initial ? fresh.filter((f) => gen - f.event.last <= STAGE_RECENT_MS) : fresh;
      // A replay being recorded plays the day's events alone; new ones wait in the feed.
      if (stage.length && !replaying) scene.ingest(stage);
      if (!scene.director() && stage.length && !initial) setCaption(stage[stage.length - 1].event);
    }
    renderSide();
    renderMini();
  }

  async function poll() {
    pollTimer = null;
    if (!open) return;
    if (!doc.hidden) {
      const feed = await fetchFeed(lastAt ? lastAt - POLL_OVERLAP_MS : 0);
      if (feed && open) apply(feed);
    }
    if (open) pollTimer = setTimeout(poll, KINGDOM_POLL_MS);
  }

  async function openView() {
    if (opening) return opening;
    opening = (async () => {
      const screen = $('kingdom-screen'); const holder = $('kingdom-view');
      if (!screen || !holder) return;
      open = true;
      screen.classList.add('is-open');
      stopMini();
      const reduced = !!(globalThis.matchMedia && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches);
      const coarse = !!((globalThis.matchMedia && globalThis.matchMedia('(pointer: coarse)').matches) || globalThis.innerWidth < 768);
      const feedP = fetchFeed(0);
      if (!scene) {
        try {
          const mod = await import('./kingdom-scene.js');
          scene = await mod.createKingdomScene(holder, { reducedMotion: reduced, coarse, onCaption: setCaption, onTier: markTier });
          markTier(scene.tier());
        } catch (e) { scene = null; }
      }
      const feed = await feedP;
      if (!open) return;
      if (feed) apply(feed, { initial: true });
      else { renderSide(); const sum = $('kingdom-summary'); if (sum) sum.textContent = 'The defence feed could not be read.'; }
      const dir = $('kingdom-director');
      if (dir && scene) { dir.setAttribute('aria-pressed', scene.director() ? 'true' : 'false'); }
      if (!pollTimer) pollTimer = setTimeout(poll, KINGDOM_POLL_MS);
    })();
    try { await opening; } finally { opening = null; }
  }

  function markTier(t) {
    const sel = $('kingdom-quality');
    if (sel && t) { sel.value = t; sel.disabled = t === 'still'; }
  }

  // --- Record mode (kingdom-record.js) ---------------------------------------------------
  function recStatus(text) { const el = $('kingdom-record-status'); if (el) el.textContent = text; }
  function endReplay() { replaying = false; for (const t of replayTimers) clearTimeout(t); replayTimers = []; }
  async function finishRecording(result) {
    recording = null; endReplay();
    const btn = $('kingdom-record-go'); if (btn) btn.textContent = 'Start';
    const link = $('kingdom-record-file');
    if (!result || !result.blob || !result.blob.size) { recStatus('Nothing was recorded.'); if (link) link.hidden = true; return; }
    if (clipUrl) URL.revokeObjectURL(clipUrl);
    clipUrl = URL.createObjectURL(result.blob);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    if (link) { link.href = clipUrl; link.download = `pg1-kingdom-${stamp}.${result.ext}`; link.hidden = false; }
    recStatus(`Recorded ${Math.round(result.seconds)} s of real PG1 events. Saved on this device only.`);
  }
  async function toggleRecording() {
    if (recording) { const r = recording; recStatus('Finishing the clip…'); await finishRecording(await r.stop()); return; }
    if (!scene || scene.renderer !== 'webgl') { recStatus('Recording needs the 3D view (it is off with reduced motion).'); return; }
    const aspect = ($('kingdom-record-aspect') || {}).value || '16:9';
    const seconds = Number(($('kingdom-record-length') || {}).value) || 30;
    const mode = ($('kingdom-record-mode') || {}).value === 'replay' ? 'replay' : 'live';
    const mod = await import('./kingdom-record.js');
    const coarse = !!(globalThis.matchMedia && globalThis.matchMedia('(pointer: coarse)').matches);
    const rec = mod.createRecording(scene, { aspect, seconds, mode, coarse, caption: () => scene.caption(), onTick: (t) => recStatus(`Recording ${Math.floor(t)} / ${seconds} s`), onDone: finishRecording });
    if (!rec) { recStatus('This browser cannot record video.'); return; }
    scene.setDirector(true);
    const dir = $('kingdom-director'); if (dir) dir.setAttribute('aria-pressed', 'true');
    if (mode === 'replay') {
      // The day's real events, in their real order, compressed into the clip.
      const plan = replaySchedule(store.list(), seconds * 1000, { now: lastAt || Date.now() });
      replaying = true;
      replayTimers = plan.map(({ at, event }) => setTimeout(() => { if (scene) scene.ingest([{ event, delta: event.count }]); }, at));
    }
    recording = rec;
    rec.start();
    const btn = $('kingdom-record-go'); if (btn) btn.textContent = 'Stop';
    const link = $('kingdom-record-file'); if (link) link.hidden = true;
  }

  function closeView() {
    if (recording) { const r = recording; r.stop().then(finishRecording); }
    endReplay();
    open = false;
    const screen = $('kingdom-screen');
    if (screen) screen.classList.remove('is-open');
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (scene) { scene.destroy(); scene = null; }
    setCaption(null);
    startMini();
  }

  // --- the mini-view -----------------------------------------------------------------
  function renderMini() {
    const mini = $('kingdom-mini');
    if (!mini) return;
    const latest = store.list().find((e) => e.role !== 'kingdom') || store.list()[0];
    if (!latest) { mini.hidden = true; return; }
    mini.hidden = false;
    mini.dataset.role = latest.role;
    mini.dataset.level = store.threat.level;
    const line = $('kingdom-mini-line');
    if (line) line.textContent = eventLine(latest);
    const when = $('kingdom-mini-time');
    if (when) when.textContent = dublinTime(latest.last);
  }
  async function miniTick() {
    miniTimer = null;
    if (open) return;
    if (!doc.hidden) {
      const feed = await fetchFeed(lastAt ? lastAt - POLL_OVERLAP_MS : 0);
      if (feed && !open) apply(feed);
      else if (!feed) { const mini = $('kingdom-mini'); if (mini && !store.size) mini.hidden = true; }
    }
    if (!open) miniTimer = setTimeout(miniTick, MINI_POLL_MS);
  }
  function startMini() { if (!miniTimer && !open) miniTimer = setTimeout(miniTick, 0); }
  function stopMini() { if (miniTimer) { clearTimeout(miniTimer); miniTimer = null; } }

  return {
    open: openView, close: closeView, startMini, stopMini,
    isOpen: () => open,
    toggleDirector() {
      if (!scene) return;
      scene.setDirector(!scene.director());
      const dir = $('kingdom-director');
      if (dir) dir.setAttribute('aria-pressed', scene.director() ? 'true' : 'false');
    },
    setQuality(t) { if (scene) scene.setTier(t); },
    toggleRecording,
    toggleRecordPanel() { const p = $('kingdom-record'); if (p) { p.hidden = !p.hidden; const b = $('kingdom-record-btn'); if (b) b.setAttribute('aria-expanded', p.hidden ? 'false' : 'true'); } },
    isRecording: () => !!recording,
    scene: () => scene,
    store
  };
}
