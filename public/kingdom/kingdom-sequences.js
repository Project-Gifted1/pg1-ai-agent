// PG1 City: how PG1 intercepts, beat by beat. Pure: no three.js, no DOM, so
// the scene, the page and the tests share it.
//
// Every interception is ONE real event from /api/defense-feed, played as a
// short sequence: approach -> detect (a sentinel scans, a lock-on ring) ->
// respond (the gadget acts) -> resolve (the threat sinks, burns, is turned
// back or held) -> an aftermath trace that stays for the Dublin day. Each
// beat comes from a field the event already has: its gadget, severity,
// verdict, reason codes and count. Nothing is invented, nothing is counted
// twice, and PG1 only defends: block, scan, catch, turn back, repair,
// stamp, light, welcome. Never a chase, never a strike back.
//
//   sequenceFor(event, { tier })   the beats, the director's shots, the tag,
//                                  the aftermath kind and the sound cue
//   pickHighlights(events, n, now) the day's top interceptions (Record mode)
//   aftermathKey(ms)               the Dublin day the traces belong to

import { defenceAction, reasonLabel, importance, DEFENCE_ACTIONS } from './kingdom-data.js';

export const BEATS = Object.freeze(['approach', 'detect', 'respond', 'resolve', 'aftermath']);
export const SHOTS = Object.freeze(['wide', 'gadget', 'tower', 'release']);
export const AFTERMATH_KINDS = Object.freeze(['buoy', 'scorch', 'patch', 'seal']);
export const MAX_AFTERMATH = 40;

// What each gadget does on its respond beat, and what it leaves behind.
const PLAY = Object.freeze({
  truth_lens: { respond: 'beam_reveal', resolve: 'burn', aftermath: 'buoy', cue: 'lens', medium: 'river' },
  phishing_net: { respond: 'net_rise', resolve: 'sink', aftermath: 'buoy', cue: 'net', medium: 'river' },
  supply_inspector: { respond: 'xray_scan', resolve: 'sink', aftermath: 'buoy', cue: 'scanner', medium: 'river' },
  sanctions_gate: { respond: 'barrier_drop', resolve: 'hold', aftermath: null, cue: 'gate', medium: 'river' },
  rate_shield: { respond: 'shield_impacts', resolve: 'turn_back', aftermath: 'scorch', cue: 'shield', medium: 'air' },
  gate_wardens: { respond: 'barrier_flash', resolve: 'turn_back', aftermath: null, cue: 'gate', medium: 'air' },
  toll_bridge: { respond: 'toll_hold', resolve: 'hold', aftermath: null, cue: 'toll', medium: 'air' },
  passkey_vault: { respond: 'vault_seal', resolve: 'turn_back', aftermath: null, cue: 'vault', medium: 'air' },
  preflight_ward: { respond: 'pylon_sequence', resolve: 'turn_back', aftermath: null, cue: 'scanner', medium: 'air' },
  repair_crews: { respond: 'repair', resolve: 'repaired', aftermath: 'patch', cue: 'repair', medium: 'kingdom' },
  seal_forge: { respond: 'stamp', resolve: 'seal_rise', aftermath: null, cue: 'seal', medium: 'kingdom' },
  beacons: { respond: 'beacon_light', resolve: 'lit', aftermath: null, cue: 'beacon', medium: 'kingdom' },
  allies: { respond: 'welcome', resolve: 'dock', aftermath: null, cue: 'welcome', medium: 'river' }
});

// One sequence for one real event. Times are seconds relative to the
// moment its attackers reach the checkpoint (the respond beat, t = 0).
// High-severity events get the director's full shot list; the Legacy
// phone tier never cuts the camera (and plays fewer particles).
export function sequenceFor(e, { tier = 'balanced' } = {}) {
  if (!e || typeof e !== 'object') return null;
  const d = defenceAction(e);
  if (!d || !DEFENCE_ACTIONS.includes(d.action)) return null;
  const play = PLAY[e.gadget];
  if (!play) return null;
  const high = e.severity === 'high';
  const legacy = tier === 'legacy';
  const attacker = e.role === 'attacker';
  // A bigger real wave takes a little longer to clear (log scale, capped).
  const n = Math.max(1, Number(e.count) || 1);
  const resolveFor = Math.min(6, 2.4 + Math.log10(n) * 1.5);
  const beats = [];
  if (attacker) beats.push({ kind: 'approach', at: -6 }, { kind: 'detect', at: -1.6 });
  beats.push({ kind: 'respond', at: 0, action: play.respond });
  beats.push({ kind: 'resolve', at: 0.8, until: 0.8 + resolveFor, action: play.resolve });
  if (play.aftermath) beats.push({ kind: 'aftermath', at: 0.8 + resolveFor, trace: play.aftermath });
  const shots = high && !legacy && attacker
    ? [{ shot: 'wide', at: -6 }, { shot: 'gadget', at: -0.6 }, { shot: 'tower', at: 2.6 }, { shot: 'release', at: 5.4 }]
    : [];
  const reason = Array.isArray(e.reasons) && e.reasons[0] ? reasonLabel(e.reasons[0]) : null;
  return Object.freeze({
    id: e.id,
    gadget: e.gadget,
    action: d.action,
    medium: play.medium,
    beats: Object.freeze(beats),
    shots: Object.freeze(shots),
    // The holographic tag over the threat: what PG1 caught it by (the real
    // reason code), never a guess.
    tag: attacker ? { scanning: 'Scanning', caught: reason ? `Caught · ${reason}` : `Caught · ${String(e.verdict || '').replace(/_/g, ' ').toLowerCase()}` } : null,
    aftermath: play.aftermath,
    cue: play.cue,
    particles: legacy ? 'few' : high ? 'many' : 'some',
    wave: e.gadget === 'rate_shield' ? Math.min(24, n) : 0
  });
}

// The day's top interceptions for a highlight reel: attackers and kingdom
// events PG1 answered, by importance (severity, wave size), ties to the
// later one; at most one per gadget so the reel shows different defences.
export function pickHighlights(events, n = 3, now = Date.now()) {
  const scored = (Array.isArray(events) ? events : [])
    .filter((e) => e && e.role === 'attacker' && sequenceFor(e))
    .map((e) => ({ e, s: importance(e, now) + (e.severity === 'high' ? 50 : 0) + Math.log10(1 + (e.count || 1)) }))
    .sort((a, b) => b.s - a.s || b.e.time - a.e.time);
  const out = []; const seen = new Set();
  for (const { e } of scored) { if (seen.has(e.gadget)) continue; seen.add(e.gadget); out.push(e); if (out.length >= n) break; }
  return out;
}

// Aftermath traces belong to one Dublin day; at midnight they are cleared.
const DAY_FMT = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }) : null;
export function aftermathKey(ms = Date.now()) {
  try { return DAY_FMT ? DAY_FMT.format(new Date(ms)) : new Date(ms).toISOString().slice(0, 10); } catch (e) { return new Date(ms).toISOString().slice(0, 10); }
}
