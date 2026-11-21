/**
 * How the Sandbox viewer chooses its starting tier (sandbox-scene.js
 * chooseStart): the caller's tier (a test, a recording), then ?quality= in
 * the address (the operator, this visit only), then a tier kept by hand from
 * the Quality menu, then the last probe's pick on this device; otherwise Low
 * on a phone (Medium on a computer) and a probe (tier-probe.js).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseStart } from '../public/sandbox/sandbox-scene.js';

const A07 = { coarse: true, memory: 4 };

test('the viewer\'s start: caller, then ?quality=, then a tier kept by hand, then the kept probe, else probe', () => {
  assert.deepEqual(chooseStart({ tier: 'high', search: '?quality=low' }), { tier: 'high', source: 'caller', probe: false, auto: false });
  assert.deepEqual(chooseStart({ search: '?quality=low', saved: 'ultra' }), { tier: 'low', source: 'address', probe: false, auto: false });
  assert.equal(chooseStart({ search: '?quality=cinematic' }).tier, 'cinematic', 'the operator may ask for any tier');
  assert.deepEqual(chooseStart({ saved: 'ultra', cached: 'low' }), { tier: 'ultra', source: 'manual', probe: false, auto: false });
  assert.deepEqual(chooseStart({ saved: 'auto', cached: 'medium' }), { tier: 'medium', source: 'probe (kept)', probe: false, auto: true });
  assert.deepEqual(chooseStart({ ...A07 }), { tier: 'low', source: 'probe', probe: true, auto: true }, 'the A07 starts on Low and probes');
  assert.deepEqual(chooseStart({ memory: 16 }), { tier: 'medium', source: 'probe', probe: true, auto: true });
});

