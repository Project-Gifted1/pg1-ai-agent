// Before a film starts: do its media engines have credit? (Routing policy:
// paid credit is reserved for media, so a film whose clips, music or stills
// cannot be paid for must stop before it spends anything on writing.)
//
// For each kind of media a film makes (video clips, music, still images),
// the engines its routing chain would use (lib/router/chains.mjs, client
// rules applied) are looked up in the /keys checks (lib/keysStatus.mjs,
// cached 5 minutes). A kind is out when it has engines and none of them is
// usable: every one is out of credit or has an invalid key. An engine whose
// credit cannot be read (Replicate shows it only on a paid call) or that is
// rate-limited or unreachable counts as usable: only a known-empty account
// stops a film.
//
// Operator-facing words only, and PG1 names, never a provider.
//
// Off with PG1_FILM_CREDIT_CHECK=0. Under Node's test runner it is off unless
// PG1_FILM_CREDIT_CHECK=1 (the same convention as the router's cache), so the
// film tests that never set up the /keys checks are not changed by it.

import { chainPlan } from '../router/chains.mjs';
import { keysStatus, STATES } from '../keysStatus.mjs';

export const MEDIA_KINDS = Object.freeze([
  Object.freeze({ id: 'clips', chain: 'clips', label: 'video clips' }),
  Object.freeze({ id: 'music', chain: 'music_film', label: 'music' }),
  Object.freeze({ id: 'stills', chain: 'stills', label: 'still images' })
]);
export const MEDIA_ENGINE_LABELS = Object.freeze({
  gemini_paid: 'PG1 Studio main media engine',
  replicate: 'PG1 Studio media fallback',
  elevenlabs: 'PG1 Sound engine'
});
const OUT_STATES = new Set([STATES.NO_CREDIT, STATES.INVALID, STATES.MISSING]);

export function creditCheckEnabled(env = {}) {
  const v = String(env.PG1_FILM_CREDIT_CHECK || '').trim();
  if (v === '0') return false;
  if (v === '1') return true;
  return !process.env.NODE_TEST_CONTEXT;
}

// { ok, out: [{ kind, label, engines: [{ engine, label, state }] }] }.
// rows: /keys rows when the caller has them (tests), else read here.
export async function filmMediaCredit({ env = {}, clientWork = false, fetchImpl = globalThis.fetch, rows = null, now = Date.now() } = {}) {
  const byEngine = new Map((rows || await keysStatus({ env, fetchImpl })).map((r) => [r.engine, r]));
  const out = [];
  for (const kind of MEDIA_KINDS) {
    const plan = chainPlan(kind.chain, { env, clientWork, now });
    const providers = [...new Set(plan.steps.map((s) => s.provider))];
    const engines = providers.map((p) => ({ engine: p, label: MEDIA_ENGINE_LABELS[p] || 'PG1 Studio engine', state: byEngine.has(p) ? byEngine.get(p).state : STATES.MISSING }));
    // No engine configured at all is the setup check's (missingFilmConfig);
    // a film with no music engine still finishes without its beds.
    if (engines.length && engines.every((e) => OUT_STATES.has(e.state))) out.push({ kind: kind.id, label: kind.label, engines });
  }
  return { ok: out.length === 0, out };
}

const STATE_WORDS = { [STATES.NO_CREDIT]: 'out of credit', [STATES.INVALID]: 'key not accepted', [STATES.MISSING]: 'not configured' };

// The reply when a film cannot start. Nothing was spent.
export function mediaCreditText(check, filmLabel = 'PG1 Studio') {
  const lines = [`${filmLabel} did not start this film: its media engines cannot pay for it. Nothing was spent, not even on the writing.`];
  for (const k of check.out) {
    lines.push(`- ${k.label}: ${k.engines.map((e) => `${e.label} ${STATE_WORDS[e.state] || e.state}`).join('; ')}`);
  }
  lines.push('Top up or fix the accounts above (/keys shows each one), then start the film again.');
  return lines.join('\n');
}
