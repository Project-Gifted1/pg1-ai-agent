// PG1 Kingdom Defence: the view's own logic, no three.js and no DOM, so the
// page, the scene and the tests share it.
//
//   normalizeEvent(e)              one /api/defense-feed event, checked
//   createEventStore()             events by id; merge(feed) -> what is new
//                                  or grew since the last poll (a wave that
//                                  grows keeps its id: only the difference
//                                  arrives as new attackers)
//   eventLine(e)                   the one-line caption: gadget, what, from
//                                  where, verdict, first reason code, count
//   importance(e, now)             how much the director camera wants it
//   dublinSun(ms)                  the real sun over Dublin (elevation and
//                                  azimuth, radians): the kingdom's day and night
//   replaySchedule(events, clipMs) the last 24 h of real events, compressed
//                                  into a clip, in their real order
//   countryBearing(code)           the direction a country's callers come
//                                  from (the great-circle bearing from Dublin)
//
// Nothing here makes an event up: every function only reshapes what the
// feed returned.

// PG1's colour language: brand gold, clean white and cyan light; allies
// glow green; red belongs to enemies only (never on a PG1 unit).
export const PG1_COLORS = Object.freeze({ gold: 0xf3c623, white: 0xf5f7fa, cyan: 0x6fd8ff, amber: 0xffb300, green: 0x3ddc84, dim: 0x5a5f66 });
export const ENEMY_COLORS = Object.freeze({ red: 0xff3d3d, eyes: 0xff6a4a, shadow: 0xb04cff });

export const GADGET_META = Object.freeze({
  truth_lens: { name: 'Truth Lens', color: 0xffd84d },
  sanctions_gate: { name: 'Sanctions Gate', color: 0xf5f7fa },
  phishing_net: { name: 'Phishing Net', color: 0x36d1c4 },
  supply_inspector: { name: 'Supply Inspector', color: 0x9be7ff },
  preflight_ward: { name: 'Preflight Array', color: 0xf3c623 },
  toll_bridge: { name: 'Toll Gantry', color: 0xffb300 },
  seal_forge: { name: 'Seal Forge', color: 0x7cc4ff },
  passkey_vault: { name: 'Passkey Vault', color: 0xd9c8ff },
  rate_shield: { name: 'Rate Shield', color: 0x5ab0ff },
  gate_wardens: { name: 'Gate Wardens', color: 0xcfd8dc },
  repair_crews: { name: 'Repair Crews', color: 0xffd27a },
  beacons: { name: 'Watchtower Beacons', color: 0xffb300 },
  allies: { name: 'Allies', color: 0x3ddc84 },
  fog_wall: { name: 'Fog Wall', color: 0x9aa4b2 },
  honeypot: { name: 'Honeypot Decoys', color: 0x6b6b74 },
  ramparts: { name: 'Firewall Ramparts', color: 0x6b6b74 }
});
export const ROLES = Object.freeze(['attacker', 'ally', 'kingdom']);
const SEVERITIES = ['low', 'medium', 'high'];
const SEV_WEIGHT = { low: 1, medium: 3, high: 8 };
const SUBJECT_LABEL = { skill_md: 'skill.md', message: 'a message', other: 'a file' };

// Values that only ever appear in test fixtures or examples, never as a real
// caller's hash: shown as "—" if one ever reached the view.
export const PLACEHOLDER_CALLER_HASHES = Object.freeze(['c0ffee00', 'aaaaaaaa', '00000000', 'ffffffff', 'deadbeef', 'abcdef12', '12345678']);

const str = (v, n, re) => { const s = typeof v === 'string' ? v.slice(0, n) : ''; return re && !re.test(s) ? '' : s; };

export function normalizeEvent(e) {
  if (!e || typeof e !== 'object') return null;
  const id = str(e.id, 32, /^[0-9a-f]{8,32}$/);
  const time = Date.parse(e.time);
  if (!id || !Number.isFinite(time) || !Object.hasOwn(GADGET_META, e.gadget)) return null;
  const last = Date.parse(e.last);
  return {
    id,
    time,
    last: Number.isFinite(last) ? Math.max(last, time) : time,
    kind: str(e.kind, 32, /^[a-z_]+$/) || 'event',
    gadget: e.gadget,
    role: ROLES.includes(e.role) ? e.role : 'attacker',
    severity: SEVERITIES.includes(e.severity) ? e.severity : 'low',
    country: str(e.country_code, 2, /^[A-Z]{2}$/) || null,
    caller: typeof e.caller_hash === 'string' && /^[0-9a-f]{8}$/.test(e.caller_hash) && !PLACEHOLDER_CALLER_HASHES.includes(e.caller_hash) ? e.caller_hash : null,
    check: str(e.check, 40, /^[A-Za-z0-9_ ./-]+$/) || 'check',
    verdict: str(e.verdict_code, 32, /^[A-Za-z0-9_]+$/) || 'EVENT',
    reasons: (Array.isArray(e.reasons) ? e.reasons : []).map((r) => str(r, 64, /^[A-Z0-9_]+$/)).filter(Boolean).slice(0, 8),
    subject: Object.hasOwn(SUBJECT_LABEL, e.subject) ? e.subject : null,
    count: Math.max(1, Math.min(1e7, Math.round(Number(e.count) || 1)))
  };
}

// Events by id. merge(feed) returns { fresh: [{ event, delta }], level, today }:
// a new event arrives with delta = its count, a wave that grew with
// delta = how much it grew. Counts per gadget follow the merged events.
export function createEventStore({ max = 800 } = {}) {
  const byId = new Map();
  let today = {};
  let threat = { level: 'calm' };
  let day = { turned_away: 0, countries: 0, settled: 0 };
  const dayCountries = new Set();
  return {
    get size() { return byId.size; },
    get today() { return { ...today }; },
    get threat() { return threat; },
    get day() { return { ...day, countries: Math.max(day.countries, dayCountries.size) }; },
    list() { return [...byId.values()].sort((a, b) => b.time - a.time || (a.id < b.id ? 1 : -1)); },
    get(id) { return byId.get(id) || null; },
    merge(feed) {
      const fresh = [];
      const events = Array.isArray(feed && feed.events) ? feed.events : [];
      if (feed && feed.today && typeof feed.today === 'object') today = Object.fromEntries(Object.entries(feed.today).filter(([k, v]) => Object.hasOwn(GADGET_META, k) && Number.isFinite(v)).map(([k, v]) => [k, Math.max(0, Math.round(v))]));
      const initial = !!(feed && feed.today);
      if (feed && feed.day && typeof feed.day === 'object') day = { turned_away: Math.max(0, Number(feed.day.turned_away) || 0), countries: Math.max(0, Number(feed.day.countries) || 0), settled: Math.max(0, Number(feed.day.settled) || 0) };
      for (const raw of events) {
        const e = normalizeEvent(raw);
        if (!e) continue;
        const cur = byId.get(e.id);
        const delta = cur ? Math.max(0, e.count - cur.count) : e.count;
        byId.set(e.id, e);
        if (!delta) continue;
        fresh.push({ event: e, delta });
        if (!initial) {
          if (e.role === 'attacker') { day.turned_away += delta; if (e.country) dayCountries.add(e.country); }
          if (e.verdict === 'SETTLED' || e.verdict === 'JOB_PAID') day.settled += delta;
          today[e.gadget] = (today[e.gadget] || 0) + delta;
          if (e.role === 'attacker' && !e.country && e.check !== 'operator_signin' && e.verdict !== 'SANCTIONS_MATCH') today.fog_wall = (today.fog_wall || 0) + delta;
        }
      }
      if (feed && feed.threat && ['calm', 'watch', 'storm'].includes(feed.threat.level)) threat = { level: feed.threat.level };
      if (byId.size > max) for (const e of this.list().slice(max)) byId.delete(e.id);
      fresh.sort((a, b) => a.event.time - b.event.time);
      return { fresh, level: threat.level, today: this.today };
    }
  };
}

// A reason code without its check's prefix: AGENT_MESSAGE_PAYMENT_REDIRECT
// reads PAYMENT_REDIRECT under the Truth Lens.
export function reasonLabel(code) {
  return String(code || '').replace(/^(?:AGENT_MESSAGE|HOSTNAME|PACKAGE|DOMAIN|WALLET)_/, '');
}

const PLAIN_VERDICT = {
  UNKNOWN_TOOL: 'unknown tool probe', UNKNOWN_METHOD: 'unknown method probe', INVALID_JSON: 'malformed call', MALFORMED_REQUEST: 'malformed call',
  PAYMENT_REQUIRED_402: 'stopped at the toll (402)', FREE_LIMIT_REACHED: 'free calls used up (402)', SETTLEMENT_FAILED: 'payment failed',
  SETTLED: 'paid and crossed', PAYER_REFUSED: 'payer refused', SANCTIONS_MATCH: 'sanctions match', RATE_LIMITED: 'rate limited',
  CALLER_FAULT: 'turned away (caller fault)', PG1_FAULT: 'PG1 took a hit (PG1 fault)', SOURCE_FAULT: 'a source failed (not the caller)',
  SIGNED: 'result signed', SEAL_VERIFIED: 'seal matched to the key', JOB_PAID: 'A2A job paid', PARTNER_CALL: 'partner call', SIGNIN_FAILED: 'failed sign-in', LOCKOUT_ALERT: 'sign-in burst: second door down', REPORT_LANDED: 'report landed', NEEDS_APPROVAL: 'waiting for Gift'
};

export function verdictText(e) {
  return PLAIN_VERDICT[e.verdict] || e.verdict;
}

// The caption, one line: gadget, what came from where, the verdict, the
// first reason, and the count of a wave.
export function eventLine(e) {
  if (!e) return '';
  const name = (GADGET_META[e.gadget] || {}).name || e.gadget;
  const from = e.role === 'kingdom' ? '' : e.country ? ` from ${e.country}` : e.check === 'operator_signin' ? '' : ' from the fog';
  const what = e.subject ? SUBJECT_LABEL[e.subject] : e.check;
  const reason = e.reasons.length ? `, ${reasonLabel(e.reasons[0])}` : '';
  const times = e.count > 1 ? ` ×${e.count}` : '';
  return `${name}: ${what}${from}, ${verdictText(e)}${reason}${times}`;
}

// What PG1 does about an event: which gadget answers and how. PG1 only
// defends: block, scan, catch, turn back, repair, stamp, light or welcome;
// never chase or strike back. null for an event no gadget answers.
const ACTION = {
  truth_lens: 'scan', sanctions_gate: 'block', phishing_net: 'catch', supply_inspector: 'scan', preflight_ward: 'scan',
  toll_bridge: 'block', seal_forge: 'stamp', passkey_vault: 'block', rate_shield: 'block', gate_wardens: 'turn_back',
  repair_crews: 'repair', beacons: 'light', allies: 'welcome'
};
export const DEFENCE_ACTIONS = Object.freeze(['block', 'scan', 'catch', 'turn_back', 'repair', 'stamp', 'light', 'welcome']);
export function defenceAction(e) {
  if (!e || !Object.hasOwn(ACTION, e.gadget)) return null;
  if (e.gadget === 'toll_bridge' && e.role === 'ally') return { gadget: 'toll_bridge', action: 'welcome' };
  return { gadget: e.gadget, action: ACTION[e.gadget] };
}

// The defence's caption: "<gadget> · <check>: <verdict> (<reason code>)".
export function defenceLine(e) {
  const d = defenceAction(e);
  if (!d) return '';
  const name = GADGET_META[d.gadget].name;
  const reason = e.reasons.length ? ` (${reasonLabel(e.reasons[0])})` : '';
  return `${name} · ${e.check}: ${verdictText(e)}${reason}`;
}

// The other side's caption, paired with it.
const ENEMY_NAME = { rate_shield: 'Siege drones', truth_lens: 'Shadow courier', passkey_vault: 'Shadow at the vault', supply_inspector: 'Trojan freighter', phishing_net: 'Mimic boat', sanctions_gate: 'Listed freighter' };
export function enemyLine(e) {
  if (!e || e.role !== 'attacker') return e && e.role === 'ally' ? `Ally${e.country ? ` from ${e.country}` : ''}${e.count > 1 ? ` ×${e.count}` : ''}` : '';
  const who = ENEMY_NAME[e.gadget] || 'Raiders';
  const from = e.country ? ` from ${e.country}` : e.check === 'operator_signin' ? '' : ' from the fog';
  return `${who}${e.count > 1 ? ` ×${e.count}` : ''}${from}`;
}

// PG1's own state for the tower (the feed's \`state\`), checked.
export function normalizeState(s) {
  const st = s && typeof s === 'object' ? s : {};
  const t = st.tower && typeof st.tower === 'object' ? st.tower : {};
  const tiers = ['bronze', 'silver', 'gold', 'platinum'];
  const n = (v) => (Number.isFinite(v) && v >= 0 ? Math.min(500, Math.round(v)) : null);
  return {
    beacon: ['gold', 'amber', 'dim', 'unknown'].includes(t.beacon) ? t.beacon : 'unknown',
    checks: n(st.checks_live),
    seal: st.seal && tiers.includes(st.seal.tier) ? st.seal.tier : null,
    passkeys: st.passkeys === true,
    signing: st.signing === true,
    approvals: n(st.approvals_waiting)
  };
}

// Director: severity, the size of the wave (log scale) and how recent.
export function importance(e, now = Date.now()) {
  if (!e) return 0;
  const age = Math.max(0, now - e.last) / 60000;
  const roleK = e.role === 'attacker' ? 1 : e.role === 'ally' ? 0.6 : e.gadget === 'repair_crews' ? 0.9 : 0.4;
  return (SEV_WEIGHT[e.severity] || 1) * (1 + Math.log10(e.count)) * roleK / (1 + age / 5);
}

export function pickDirectorEvent(events, now = Date.now(), { exclude = null } = {}) {
  let best = null; let bestScore = 0;
  for (const e of events) {
    if (!e || (exclude && e.id === exclude)) continue;
    const s = importance(e, now);
    if (s > bestScore) { best = e; bestScore = s; }
  }
  return best;
}

// --- the sun over Dublin -------------------------------------------------------------------
export const DUBLIN = Object.freeze({ lat: 53.3498, lon: -6.2603 });
const RAD = Math.PI / 180;

// The sun's elevation and azimuth (radians, azimuth clockwise from north)
// at a moment, over Dublin (NOAA's low-precision formulae, within a degree).
export function dublinSun(ms = Date.now(), { lat = DUBLIN.lat, lon = DUBLIN.lon } = {}) {
  const d = ms / 86400000 + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
  const ha = (gmst * 15 + lon) * RAD - ra;
  const la = lat * RAD;
  const el = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(ha));
  return { elevation: el, azimuth: (az + 2 * Math.PI) % (2 * Math.PI) };
}

// Day (1) to night (0), with a soft dusk around the horizon.
export function daylight(elevation) {
  const t = Math.min(1, Math.max(0, (elevation + 0.1) / 0.25));
  return t * t * (3 - 2 * t);
}

// --- where callers come from ---------------------------------------------------------------
// Approximate centres (lat, lon) of the countries most callers come from;
// anything else gets a stable bearing from its code. The bearing is only
// where on the horizon they appear: the code itself is always shown.
const CENTRES = {
  US: [39, -98], CA: [56, -106], MX: [23, -102], BR: [-10, -52], AR: [-34, -64], CL: [-33, -71], CO: [4, -73],
  GB: [54, -2], IE: [53, -8], FR: [46, 2], DE: [51, 10], NL: [52, 5], BE: [50.5, 4.5], ES: [40, -4], PT: [39.5, -8],
  IT: [42, 12], CH: [47, 8], AT: [47.5, 14], PL: [52, 19], CZ: [49.8, 15.5], SE: [62, 15], NO: [61, 9], FI: [64, 26],
  DK: [56, 10], UA: [49, 32], RU: [60, 90], TR: [39, 35], RO: [46, 25], BG: [42.7, 25.5], GR: [39, 22], HU: [47, 19.5],
  IL: [31, 35], IR: [32, 53], SA: [24, 45], AE: [24, 54], EG: [27, 30], NG: [9, 8], ZA: [-29, 24], KE: [0.5, 38],
  IN: [21, 78], PK: [30, 70], BD: [24, 90], CN: [35, 103], HK: [22.3, 114.2], TW: [23.7, 121], JP: [36, 138], KR: [36, 128],
  KP: [40, 127], SG: [1.35, 103.8], VN: [16, 107], TH: [15, 101], MY: [4, 102], ID: [-2, 118], PH: [13, 122],
  AU: [-25, 134], NZ: [-41, 174], LT: [55.2, 23.9], LV: [56.9, 24.6], EE: [58.6, 25], BY: [53.7, 28], KZ: [48, 67]
};

export function countryBearing(code) {
  const c = CENTRES[code];
  if (!c) {
    let h = 0;
    for (const ch of String(code || 'XX')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return (h % 3600) / 3600 * Math.PI * 2;
  }
  const [la1, lo1, la2, lo2] = [DUBLIN.lat * RAD, DUBLIN.lon * RAD, c[0] * RAD, c[1] * RAD];
  const y = Math.sin(lo2 - lo1) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(lo2 - lo1);
  return (Math.atan2(y, x) + 2 * Math.PI) % (2 * Math.PI);
}

// --- replay ---------------------------------------------------------------------------------
// The day's real events, oldest first, placed on a clip of clipMs: each at
// its real time scaled into the clip (0.5 s of lead-in, 1.5 s at the end),
// and never two closer than minGapMs (a busy minute spreads out a little,
// still in order). Returns [{ at, event }] with at in ms from the start.
export function replaySchedule(events, clipMs, { windowMs = 24 * 3600 * 1000, now = Date.now(), minGapMs = 250, max = 400 } = {}) {
  const from = now - windowMs;
  const list = events.filter((e) => e && e.time >= from && e.time <= now).sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1));
  // A long day: the most important events, still in time order.
  const kept = list.length > max ? list.map((e) => [e, importance(e, e.last)]).sort((a, b) => b[1] - a[1]).slice(0, max).map((x) => x[0]).sort((a, b) => a.time - b.time) : list;
  const start = 500; const span = Math.max(1000, clipMs - 2000);
  const out = [];
  let prev = -Infinity;
  for (const e of kept) {
    let at = start + ((e.time - from) / windowMs) * span;
    if (at < prev + minGapMs) at = prev + minGapMs;
    if (at > start + span) at = start + span;
    out.push({ at: Math.round(at), event: e });
    prev = at;
  }
  return out;
}

// Times on screen: the Europe/Dublin wall clock.
const TIME_FMT = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : null;
export function dublinTime(ms) {
  try { return TIME_FMT ? TIME_FMT.format(new Date(ms)) : new Date(ms).toISOString().slice(11, 16); } catch (e) { return ''; }
}
