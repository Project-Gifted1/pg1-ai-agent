/**
 * PG1 City, honest wording (23 Nov, seen on a Galaxy A07):
 *   - the day's count is "N probes turned away today", matching the banner;
 *     "attacks" only when every counted event is a blocked attack
 *     (lib/defenseFeed.mjs dayTotals kind, BLOCKED_ATTACK_KINDS);
 *   - an unknown-method probe is "Probe ×3 from DE", never "Raiders";
 *     "Raiders" only for an event the code classifies as an attack;
 *   - the banner's tail ("5 countries · last 24 h") is held together, so a
 *     word is never alone on its last line;
 *   - the quality menu's phone label is short enough to show whole;
 *   - the drones' look never depends on an environment map.
 * The 360 px layout and the drones on Low are checked in a browser
 * (tests/browser/kingdom-a07.browser.test.mjs).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const data = await import('../public/kingdom/kingdom-data.js');
const feed = await import('../lib/defenseFeed.mjs');

const ev = (o) => data.normalizeEvent({ id: 'abcdef0123456789', time: new Date().toISOString(), gadget: 'gate_wardens', kind: 'probe', role: 'attacker', check: 'mcp_router', verdict_code: 'UNKNOWN_METHOD', country_code: 'DE', count: 3, ...o });

test('an unknown-method probe reads "Probe ×3 from DE"; "Raiders" only for a blocked attack', () => {
  assert.equal(data.enemyLine(ev({})), 'Probe ×3 from DE');
  assert.equal(data.enemyLine(ev({ count: 1 })), 'Probe from DE');
  assert.equal(data.enemyLine(ev({ country_code: null })), 'Probe ×3 from the fog');
  assert.match(data.tickerLine(ev({})), /^🇩🇪 DE · Probe · mcp_router: unknown method probe ×3$/);
  // Every kind the feed classifies: only a blocked attack is "Raiders".
  const kinds = { probe: 'gate_wardens', caller_fault: 'gate_wardens', rate_limited: 'rate_shield', payment_challenge: 'toll_bridge', payment_failed: 'toll_bridge', signin_failed: 'passkey_vault', lockout: 'passkey_vault', check_verdict: 'truth_lens', payer_refused: 'sanctions_gate' };
  for (const [kind, gadget] of Object.entries(kinds)) {
    const line = data.enemyLine(ev({ kind, gadget, check: kind === 'signin_failed' ? 'operator_signin' : 'x' }));
    if (data.BLOCKED_ATTACK_KINDS.includes(kind)) assert.match(line, /^Raiders/, kind);
    else assert.ok(!/Raiders|Siege|Shadow|Trojan|Mimic|hostile|attack/i.test(line), `${kind}: ${line}`);
  }
  assert.equal(data.enemyLine(ev({ kind: 'rate_limited', gadget: 'rate_shield', count: 9, country_code: null })), 'Rate-limited calls ×9 from the fog');
  assert.equal(data.enemyLine(ev({ kind: 'check_verdict', gadget: 'phishing_net', count: 1, country_code: 'FR' })), 'Flagged domain from FR');
});

test('the blocked-attack kinds are the same in the feed and the page', () => {
  assert.deepEqual([...data.BLOCKED_ATTACK_KINDS], [...feed.BLOCKED_ATTACK_KINDS]);
});

test('"N probes turned away today", unless every counted event was a blocked attack', () => {
  const now = Date.now();
  const e = (kind, count = 1) => ({ time: new Date(now - 1000).toISOString(), role: 'attacker', kind, count, country_code: 'DE' });
  assert.equal(feed.dayTotals([e('probe', 4), e('rate_limited', 2)], now).kind, 'probes');
  assert.equal(feed.dayTotals([e('payer_refused', 2), e('probe')], now).kind, 'probes');
  assert.equal(feed.dayTotals([e('payer_refused', 2)], now).kind, 'blocked');
  assert.equal(feed.dayTotals([], now).kind, 'probes', 'nothing counted');
  assert.equal(data.turnedAwayText(31), '31 probes turned away today');
  assert.equal(data.turnedAwayText(1), '1 probe turned away today');
  assert.equal(data.turnedAwayText(2, 'blocked'), '2 attacks turned away today');
  assert.equal(data.billboardLines({ countries: 5, threats: 31, checks: 21 })[1], '31 probes turned away today');
  assert.ok(!data.billboardLines({ threats: 3 }).some((l) => /threat/.test(l)));
  // The page's running count keeps the kind: a probe makes it "probes".
  const store = data.createEventStore();
  store.merge({ today: {}, day: { turned_away: 2, countries: 1, settled: 0, kind: 'blocked' }, events: [] });
  assert.equal(store.day.kind, 'blocked');
  store.merge({ events: [{ id: 'abcdef0123456788', time: new Date().toISOString(), gadget: 'gate_wardens', kind: 'probe', role: 'attacker', check: 'mcp_router', verdict_code: 'UNKNOWN_METHOD', country_code: 'DE', count: 1 }] });
  assert.equal(store.day.kind, 'probes');
});

test('the banner\'s tail is held together: never "last" / "24 h" or "h" alone', () => {
  for (const [n, kind] of [[0, undefined], [1, undefined], [12, undefined], [5, 'blocked']]) {
    const t = data.countriesText(n, kind);
    assert.match(t, new RegExp(`${n}\\u00a0countr(y|ies)\\u00a0·\\u00a0last\\u00a024\\u00a0h$`));
    assert.equal(t.replace(/ /g, ' '), `${kind === 'blocked' ? 'Hostile traffic' : 'Probes and checks'} from ${n} ${n === 1 ? 'country' : 'countries'} · last 24 h`);
  }
});

test('the quality menu: the phone label is short and whole', async () => {
  const look = await import('../public/kingdom/kingdom-look.js');
  assert.equal(look.CINEMATIC_PHONE_LABEL, 'Cinematic (manual)');
  assert.ok(look.CINEMATIC_PHONE_LABEL.length <= 18);
});

test('the drones: a light, non-metal, self-lit body; unlit nav lights and strobe; underglow at night', async () => {
  const a = await import('../public/kingdom/kingdom-actors.js');
  const lum = (hex) => (0.2126 * ((hex >> 16) & 255) + 0.7152 * ((hex >> 8) & 255) + 0.0722 * (hex & 255)) / 255;
  assert.ok(lum(a.ENEMY_BODY) >= 0.5 && lum(a.PG1_BODY) >= 0.9);
  assert.ok(a.DRONE_LOOK.metalness <= 0.3, 'no metal: a metal body is black with no environment map');
  assert.ok(a.DRONE_LOOK.selfLight > 0);
  assert.equal(a.DRONE_LOOK.navRed >> 16, 0xff);
  assert.equal((a.DRONE_LOOK.navGreen >> 8) & 255, 0xff);
  assert.equal(a.DRONE_LOOK.strobe, 0xffffff);
  assert.ok(a.DRONE_LOOK.glowNight > 0 && a.DRONE_LOOK.glowNight <= 0.3, 'faint');
  // The strobe flashes briefly, about once a second.
  let on = 0; for (let i = 0; i < 1000; i++) if (a.strobeOn(i / 100, 0.3)) on++;
  assert.ok(on > 50 && on < 200, `${on} of 1000 samples lit`);
});
