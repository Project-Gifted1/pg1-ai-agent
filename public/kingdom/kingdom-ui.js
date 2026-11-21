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
// Only real events are drawn. When the view opens, the last few real events
// of the day are replayed first, captioned "Earlier today · <time>"; after
// that, every event a poll brings in plays as it lands, captioned
// "LIVE · <seconds> ago", and a burst grows with its true running count.
// Nothing is generated for quiet periods: the city stays calm and the
// ticker says so. The badge "● LIVE · Real PG1 events — not a simulation"
// pulses only while the feed answers; when it stops answering the badge
// says "Feed paused — showing last real events" and nothing new plays.

import { createEventStore, eventLine, enemyLine, defenceLine, dublinTime, verdictText, reasonLabel, replaySchedule, normalizeState, flagOf, originTag, plural, whenLabel, captionLine, tickerLine, countriesText, BADGE, GADGET_META } from './kingdom-data.js';

export const KINGDOM_POLL_MS = 5000;
export const MINI_POLL_MS = 30000;
export const STAGE_RECENT_MS = 3 * 60 * 1000;
export const FEED_ROWS = 200;
export const REPLAY_ON_OPEN = 6;
export const TICKER_ROWS = 5;
export const LIVE_WINDOW_MS = 90 * 1000;
export const PAUSED_AFTER_FAILS = 2;
export const FLAG_PX = 24;
// Threats only: payment events (a settled payment, a paid job) are not shown.
export const isPayment = (e) => !!e && (e.verdict === 'SETTLED' || e.verdict === 'JOB_PAID');
const POLL_OVERLAP_MS = 70 * 1000;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function feedRowHtml(e) {
  const reason = e.reasons.length ? ` · ${esc(reasonLabel(e.reasons[0]))}` : '';
  const where = e.role === 'kingdom' ? 'PG1' : e.country ? originTag(e) : (e.check === 'operator_signin' ? '—' : 'fog');
  return `<li class="kd-row" data-role="${esc(e.role)}" data-sev="${esc(e.severity)}" data-id="${esc(e.id)}">`
    + `<time datetime="${new Date(e.time).toISOString()}">${esc(dublinTime(e.time))}</time>`
    + `<span class="kd-cc" aria-label="${e.country ? `country ${esc(e.country)}` : esc(where)}">${esc(where)}</span>`
    + `<span class="kd-what"><strong>${esc((GADGET_META[e.gadget] || {}).name || e.gadget)}</strong> · ${esc(e.check)} · ${esc(verdictText(e))}${reason} · <code aria-label="${e.caller ? `caller ${esc(e.caller)}` : 'no caller identity'}">${e.caller ? esc(e.caller) : '—'}</code></span>`
    + `<span class="kd-n">${e.count > 1 ? `×${e.count}` : ''}</span></li>`;
}

// The guardians: ambient, always there, never counted as defences.
export const GUARDIANS = Object.freeze([
  { id: 'sentinels', name: 'Sentinel drones', what: 'one per check live in the MCP tool list' },
  { id: 'commander', name: 'Commander drone', what: 'docked at the Command Centre deck' },
  { id: 'pilots', name: 'Harbour pilots', what: 'guide allies to the pier' },
  { id: 'rovers', name: 'Ground rovers', what: 'light the embankment in storms and floods' }
]);

// The HUD line, all from the data: "loading…" until the first answer;
// "not read" for a source PG1 could not read.
export function hudText(state, day, { loaded = true } = {}) {
  if (!loaded) return 'Defences: loading…';
  const st = state || {};
  const checks = Number.isFinite(st.checks) ? plural(st.checks, 'check') + ' live' : 'checks live: not read';
  return `Defences active: ${checks} · ${plural(Number(day && day.turned_away) || 0, 'threat')} turned away today`;
}

// The flag strip: the top origins, then "+M".
export function flagStrip(origins, top = 5) {
  const head = origins.slice(0, top).map(([cc]) => flagOf(cc)).join('');
  return origins.length > top ? `${head} +${origins.length - top}` : head;
}

export function legendHtml(gadgets, today, state = null) {
  const guard = GUARDIANS.map((g) => `<li data-guardian="${g.id}"><span class="kd-dot kd-dot-guard"></span><span class="kd-gname">${esc(g.name)}</span><span class="kd-gcheck">${esc(g.what)} · ambient</span><span class="kd-gcount">${g.id === 'sentinels' && state && Number.isFinite(state.checks) ? state.checks : ''}</span></li>`).join('');
  return guard + gadgets.map((g) => `<li data-gadget="${esc(g.id)}"${g.reserved ? ' data-reserved="true"' : ''}><span class="kd-dot" style="background:#${((GADGET_META[g.id] || {}).color || 0x888888).toString(16).padStart(6, '0')}"></span><span class="kd-gname">${esc(g.name)}</span><span class="kd-gcheck">${esc(g.check)}${g.reserved ? ' · idle until its data exists' : ''}</span><span class="kd-gcount">${Number(today[g.id] || 0)}</span></li>`).join('');
}

export function createKingdomUi({ creds, fetchImpl = (...a) => fetch(...a), doc = document } = {}) {
  const $ = (id) => doc.getElementById(id);
  const store = createEventStore();
  let scene = null; let open = false; let pollTimer = null; let miniTimer = null; let lastAt = 0; let gadgets = []; let opening = null;
  let recording = null; let replaying = false; let replayTimers = []; let clipUrl = null;
  let pg1State = null; let loaded = false; let lastRec = null; let sound = null; let lastWeather = null;
  let connected = false; let fails = 0; let lastOkAt = 0;
  const liveIds = new Set(); const replayIds = new Set();
  let ticker = []; let arcs = []; let captionEvent = null; let tickTimer = null; let pip = null; let introDone = false;

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
    const list = store.list().filter((e) => !isPayment(e));
    const feed = $('kingdom-feed');
    if (feed) feed.innerHTML = list.length ? list.slice(0, FEED_ROWS).map(feedRowHtml).join('') : '<li class="kd-empty">No defence events in the last 24 hours. The kingdom is calm.</li>';
    const legend = $('kingdom-legend');
    if (legend && gadgets.length) legend.innerHTML = legendHtml(gadgets, store.today, pg1State);
    const hud = $('kingdom-hud');
    if (hud) hud.textContent = hudText(pg1State, store.day, { loaded });
    renderCountries();
    if (scene && scene.setBillboards) scene.setBillboards(loaded ? { countries: store.origins.length, threats: Number(store.day.turned_away) || 0, checks: pg1State && Number.isFinite(pg1State.checks) ? pg1State.checks : null } : {});
    const level = store.threat.level;
    const mode = $('kingdom-mode');
    if (mode) { mode.dataset.mode = level; mode.textContent = level === 'storm' ? 'Under attack' : level === 'watch' ? 'On watch' : 'Calm'; }
    const sum = $('kingdom-summary');
    const attackers = list.filter((e) => e.role === 'attacker').reduce((n, e) => n + e.count, 0);
    if (sum) sum.textContent = `${level === 'storm' ? 'Under attack' : level === 'watch' ? 'On watch' : 'Calm'}: ${list.length} defence events in the last 24 hours, ${attackers} turned away or flagged.`;
  }

  // The caption: when (LIVE or Earlier today), the other side's line, and
  // PG1's answer with the flag and ISO code. Refreshed every second (the
  // seconds count, and a growing burst's running total).
  function captionText(e) {
    if (!e) return '';
    const cur = store.get(e.id) || e;
    return `${whenLabel(cur, { replay: !liveIds.has(cur.id) })} · ${captionLine(cur)}`;
  }
  function setCaption(e) {
    captionEvent = e || null;
    const cap = $('kingdom-caption');
    if (!cap) return;
    if (!e) { cap.textContent = ''; cap.hidden = true; return; }
    const cur = store.get(e.id) || e;
    const live = liveIds.has(cur.id);
    const enemy = enemyLine(cur);
    cap.dataset.live = live ? 'true' : 'false';
    cap.innerHTML = `<span class="kd-cap-when" data-live="${live}">${esc(whenLabel(cur, { replay: !live }))}</span>${enemy ? `<span class="kd-cap-enemy">${esc(originTag(cur))} · ${esc(enemy)}</span>` : ''}<span class="kd-cap-defence">${esc(captionLine(cur))}</span>`;
    cap.hidden = false;
  }

  // The badge, the country counter, the ticker, the mini-globe.
  const paused = () => !connected && !replaying && loaded && fails >= PAUSED_AFTER_FAILS;
  function renderBadge() {
    const b = $('kingdom-badge');
    if (!b) return;
    const text = replaying ? BADGE.replay : connected ? BADGE.live : BADGE.paused;
    if (b.textContent !== text) b.textContent = text;
    b.dataset.state = replaying ? 'replay' : connected ? 'live' : 'paused';
  }
  function renderCountries() {
    const c = $('kingdom-countries');
    if (!c) return;
    const o = store.origins;
    c.dataset.n = String(o.length);
    const strip = $('kingdom-flags'); if (strip) strip.textContent = flagStrip(o);
    const t = $('kingdom-countries-text'); if (t) t.textContent = countriesText(o.length);
  }
  function popFlag(e) {
    const pop = $('kingdom-pop');
    if (!pop || !e.country) return;
    pop.textContent = originTag(e);
    pop.hidden = false;
    pop.dataset.at = String(Date.now());
    setTimeout(() => { if (Date.now() - Number(pop.dataset.at) >= 3900) pop.hidden = true; }, 4000);
  }
  function renderTicker() {
    const el = $('kingdom-ticker');
    if (!el) return;
    const now = Date.now();
    const recent = ticker.filter((e) => now - e.last <= LIVE_WINDOW_MS);
    if (recent.length) {
      el.dataset.state = 'live';
      el.innerHTML = recent.slice(0, TICKER_ROWS).map((e) => `<li data-id="${esc(e.id)}">${esc(tickerLine(store.get(e.id) || e))}</li>`).join('');
    } else {
      const latest = store.list()[0];
      el.dataset.state = 'quiet';
      const ago = latest ? Math.round((now - latest.last) / 60000) : null;
      el.innerHTML = `<li class="kd-quiet">${latest ? `Quiet · last event ${ago < 1 ? 'under a minute' : plural(ago, 'minute')} ago` : 'Quiet · no events in the last 24 hours'}</li>`;
    }
  }
  function renderPip() {
    const cv = $('kingdom-globe-pip');
    if (!cv) return;
    if (!pip) { const dpr = Math.min(2, globalThis.devicePixelRatio || 1); cv.width = cv.clientWidth * dpr || 240; cv.height = cv.clientHeight * dpr || 240; pip = { mod: null, globe: null }; import('./kingdom-globe.js').then((m) => { pip.globe = m.createGlobe(cv, { flagPx: 18 }); }); }
    if (!pip.globe) return;
    const now = Date.now();
    arcs = arcs.filter((a) => now - a.at < 6000);
    pip.globe.draw({ origins: store.origins, arcs: arcs.map((a) => ({ cc: a.cc, age: (now - a.at) / 6000 })), t: now / 1000 });
    cv.dataset.arcs = String(arcs.length);
  }
  function tick() {
    tickTimer = null;
    if (!open) return;
    connected = fails < PAUSED_AFTER_FAILS && Date.now() - lastOkAt < KINGDOM_POLL_MS * 3;
    if (scene && scene.setPaused) scene.setPaused(!connected && !replaying);
    renderBadge();
    renderTicker();
    renderPip();
    if (captionEvent) setCaption(captionEvent);
    tickTimer = setTimeout(tick, 250);
  }

  // The opening shot: the globe turns to Dublin, arcs from the real origins
  // converge on PG1, then the dive into the city.
  async function playIntro() {
    const cv = $('kingdom-globe-intro');
    if (!cv || introDone) return;
    introDone = true;
    const reduced = !!(globalThis.matchMedia && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (reduced) return;
    const m = await import('./kingdom-globe.js');
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    cv.hidden = false; cv.classList.remove('is-done');
    cv.width = Math.max(2, cv.clientWidth * dpr); cv.height = Math.max(2, cv.clientHeight * dpr);
    const globe = m.createGlobe(cv, { flagPx: FLAG_PX });
    cv.dataset.flagPx = String(FLAG_PX);
    const t0 = performance.now(); const DUR = 3200;
    await new Promise((resolve) => {
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / DUR); const e = k * k * (3 - 2 * k);
        const r = globe.draw({ origins: store.origins, arcs: store.origins.slice(0, 8).map(([cc], i) => ({ cc, age: Math.max(0, Math.min(1, e * 1.4 - i * 0.05)) })), lon: -70 + e * 63.7, lat: 30 + e * 15, t: k * 4, dpr });
        if (r) cv.dataset.shown = r.shown.join(',');
        if (k < 1 && open) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
    cv.classList.add('is-done');
    setTimeout(() => { cv.hidden = true; }, 700);
  }

  function apply(feed, { initial = false } = {}) {
    if (Array.isArray(feed.gadgets)) gadgets = feed.gadgets.filter((g) => g && typeof g.id === 'string' && Object.hasOwn(GADGET_META, g.id)).map((g) => ({ id: g.id, name: String(g.name || g.id).slice(0, 40), check: String(g.check || '').slice(0, 60), reserved: !!g.reserved }));
    const { fresh, level } = store.merge(feed);
    loaded = true;
    if (feed.state) pg1State = normalizeState(feed.state);
    const gen = Date.parse(feed.generated_at);
    if (Number.isFinite(gen)) lastAt = gen;
    if (scene) {
      scene.setThreat(level);
      scene.setToday(store.today);
      if (feed.state) scene.setState(feed.state);
      // The real Dublin weather, for the sky only (full loads carry it).
      if (Object.hasOwn(feed, 'weather') && scene.setWeather) { scene.setWeather(feed.weather); lastWeather = feed.weather; if (sound && sound.setWeather && feed.weather) sound.setWeather({ rain: Number(feed.weather.rain) || (/rain|drizzle/.test(feed.weather.state) ? 0.5 : 0), wind: Number(feed.weather.wind) || 0 }); }
      scene.setDay(store.day);
      // On open: replay the last few real events of the day (from the store:
      // the mini-view may have merged them already), oldest first. They are
      // "Earlier today". Everything a poll brings in after that is LIVE.
      let stage;
      if (initial) {
        stage = store.list().filter((e) => !isPayment(e) && (e.role !== 'kingdom' || e.gadget !== 'seal_forge')).slice(0, REPLAY_ON_OPEN).reverse().map((e) => ({ event: e, delta: e.count }));
        for (const f of stage) replayIds.add(f.event.id);
      } else {
        stage = fresh.filter((f) => !isPayment(f.event));
        for (const f of stage) {
          if (!replayIds.has(f.event.id)) liveIds.add(f.event.id);
          ticker = [f.event, ...ticker.filter((x) => x.id !== f.event.id)].slice(0, 20);
          if (f.event.role === 'attacker' && f.event.country) { arcs.push({ cc: f.event.country, at: Date.now() }); popFlag(f.event); }
        }
      }
      // A replay being recorded plays the day's events alone; new ones wait in the feed.
      if (stage.length && !replaying) scene.ingest(stage, { live: !initial });
      if (stage.length && initial) setCaption(stage[stage.length - 1].event);
      // A live arrival takes the caption, and the director cuts to it.
      const liveNow = !initial && fresh.filter((f) => liveIds.has(f.event.id));
      if (liveNow && liveNow.length && !paused()) { const e = liveNow[liveNow.length - 1].event; setCaption(e); if (scene.cutTo) scene.cutTo(e.id); }
    }
    renderSide();
    renderMini();
    if (open) { renderTicker(); renderBadge(); }
  }

  async function poll() {
    pollTimer = null;
    if (!open) return;
    if (!doc.hidden) {
      const feed = await fetchFeed(lastAt ? lastAt - POLL_OVERLAP_MS : 0);
      if (feed && open) { fails = 0; lastOkAt = Date.now(); apply(feed); } else if (!feed) fails++;
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
      renderSide(); renderBadge();
      stopMini();
      const reduced = !!(globalThis.matchMedia && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches);
      const coarse = !!((globalThis.matchMedia && globalThis.matchMedia('(pointer: coarse)').matches) || globalThis.innerWidth < 768);
      const feedP = fetchFeed(0);
      if (!scene) {
        try {
          const mod = await import('./kingdom-scene.js');
          scene = await mod.createKingdomScene(holder, { reducedMotion: reduced, coarse, onCaption: setCaption, onTier: markTier, onGadget: () => { if (sound) sound.alert(); } });
          const ls = $('kingdom-light'); if (ls) ls.value = 'live';
          markTier(scene.tier());
        } catch (e) { scene = null; }
      }
      const feed = await feedP;
      if (!open) return;
      if (feed) { fails = 0; lastOkAt = Date.now(); apply(feed, { initial: true }); }
      else { fails = PAUSED_AFTER_FAILS; loaded = true; renderSide(); const sum = $('kingdom-summary'); if (sum) sum.textContent = 'The defence feed could not be read.'; }
      if (!tickTimer) tick();
      if (scene && scene.renderer === 'webgl') playIntro();
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
  function endReplay() { replaying = false; for (const t of replayTimers) clearTimeout(t); replayTimers = []; if (open) renderBadge(); }
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
    const rec = mod.createRecording(scene, { aspect, seconds, mode, coarse, legacy: scene.tier && scene.tier() === 'legacy', caption: () => scene.caption(), captionText: () => captionText(scene.caption()), countries: () => ({ n: store.origins.length, strip: flagStrip(store.origins) }), day: () => store.day, onTick: (t) => recStatus(`Recording ${Math.floor(t)} / ${seconds} s`), onDone: finishRecording });
    if (!rec) { recStatus('This browser cannot record video.'); return; }
    scene.setDirector(true);
    const dir = $('kingdom-director'); if (dir) dir.setAttribute('aria-pressed', 'true');
    const lightSel = $('kingdom-light'); if (lightSel) lightSel.value = 'dusk';
    // The end card: back to the tower for the day's counts.
    setTimeout(() => { if (recording === rec && scene) { scene.setDirector(false); scene.focus(null); } }, Math.max(0, (seconds - 3.5) * 1000));
    if (mode === 'replay') {
      // The day's real events, in their real order, compressed into the clip.
      const plan = replaySchedule(store.list(), seconds * 1000, { now: lastAt || Date.now() });
      replaying = true;
      for (const { event } of plan) { replayIds.add(event.id); liveIds.delete(event.id); }
      renderBadge();
      replayTimers = plan.map(({ at, event }) => setTimeout(() => { if (scene) scene.ingest([{ event, delta: event.count }]); }, at));
    }
    recording = rec; lastRec = rec;
    rec.start();
    const btn = $('kingdom-record-go'); if (btn) btn.textContent = 'Stop';
    const link = $('kingdom-record-file'); if (link) link.hidden = true;
  }

  function closeView() {
    if (recording) { const r = recording; r.stop().then(finishRecording); }
    endReplay();
    open = false;
    if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
    if (sound && sound.on) { sound.toggle(); const b = $('kingdom-sound'); if (b) b.setAttribute('aria-pressed', 'false'); }
    pip = null; introDone = false;
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
    const shown = store.list().filter((e) => !isPayment(e));
    const latest = shown.find((e) => e.role !== 'kingdom') || shown[0];
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
    setLight(m) { if (scene && scene.setLight) scene.setLight(m); },
    // Sound: off by default; city ambience and a chime when a real gadget fires.
    async toggleSound() {
      if (!sound) sound = (await import('./kingdom-sound.js')).createSound();
      const on = sound.toggle();
      if (on && lastWeather && sound.setWeather) sound.setWeather({ rain: Number(lastWeather.rain) || (/rain|drizzle/.test(lastWeather.state) ? 0.5 : 0), wind: Number(lastWeather.wind) || 0 });
      const b = $('kingdom-sound'); if (b) b.setAttribute('aria-pressed', on ? 'true' : 'false');
      return on;
    },
    toggleRecording,
    toggleRecordPanel() { const p = $('kingdom-record'); if (p) { p.hidden = !p.hidden; const b = $('kingdom-record-btn'); if (b) b.setAttribute('aria-expanded', p.hidden ? 'false' : 'true'); } },
    isRecording: () => !!recording,
    // For the tests: the claim and the live state as shown.
    status: () => ({ connected, fails, live: [...liveIds], replay: [...replayIds], ticker: ticker.map((e) => e.id), recTexts: lastRec ? lastRec.texts : [] }),
    scene: () => scene,
    store
  };
}
