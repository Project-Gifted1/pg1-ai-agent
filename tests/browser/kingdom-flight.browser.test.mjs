/**
 * PG1 City: no drone ever flies through a building. In a real browser, the
 * drawn city's buildings (every instance of the skyline meshes, boxed from
 * its own geometry and matrix, not from the obstacle list the drones steer
 * by) and every flying agent (the patrol rings, one sentinel for each of 64
 * checks, the commander, repair drones, partners and the drones of the
 * fixture feed's probes) sampled every 0.1 s over 130 s of patrols: a full
 * turn of every ring. Fails if any sample is inside a building's box.
 * Run on the High tier and on the A07's Medium (phone) tier: the same rules
 * in the live City and the Showcase render (the same actors).
 * Skipped (not failed) when Playwright or a Chromium is not installed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeReplyFont } from '../helpers/replyFont.mjs';
import { startCommandCentreServer, openPhonePage } from '../helpers/commandCentre.mjs';
import { fixtureFeed } from '../helpers/kingdomFixtures.mjs';
import { insideBox } from '../../public/kingdom/kingdom-flight.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = join(ROOT, 'public');

let chromium = null; let executablePath; let skip = false;
try { ({ chromium } = await import('playwright')); } catch (e) { skip = 'playwright is not installed (npm install)'; }
if (chromium && !existsSync(chromium.executablePath())) {
  if (existsSync('/opt/pw-browsers/chromium')) executablePath = '/opt/pw-browsers/chromium';
  else skip = `Chromium is not installed at ${chromium.executablePath()}`;
}

async function audit(t, tier) {
  const feed = fixtureFeed({});
  const { server, origin } = await startCommandCentreServer({ publicDir: PUBLIC_DIR, defenseFeed: feed });
  const browser = await chromium.launch({ executablePath, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(async () => { await browser.close(); await new Promise((r) => server.close(r)); });
  const { page, errors } = await openPhonePage(browser, origin, { width: 412, height: 915, routeReplyFont });
  await page.evaluate((x) => { try { localStorage.setItem('pg1_kingdom_quality', x); } catch (e) {} }, tier);
  await page.locator('#kingdom-mini').waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('#kingdom-mini').click();
  await page.waitForFunction(() => document.getElementById('kingdom-view').dataset.renderer === 'webgl' && !!window.kingdomUi.scene() && Number(document.getElementById('kingdom-view').dataset.frames || 0) > 2, null, { timeout: 300000 });
  await page.evaluate(() => window.kingdomUi.scene().pause(true));
  const { boxes, samples } = await page.evaluate(() => window.kingdomUi.scene().flightAudit(130, { sentinels: 64 }));
  return { boxes, samples, errors };
}

for (const tier of ['balanced', 'phone']) {
  test(`no drone flies through a building (${tier} tier): every flight path sampled against the drawn buildings`, { skip, timeout: 900000 }, async (t) => {
    const { boxes, samples, errors } = await audit(t, tier);
    assert.ok(boxes.length > 300, `${boxes.length} building boxes`);
    assert.ok(samples.length > 64 * 1000, `${samples.length} samples`);
    const bad = [];
    for (const s of samples) { const b = insideBox(boxes, s.x, s.y, s.z); if (b) bad.push(`crowd ${s.crowd} at (${s.x.toFixed(1)}, ${s.y.toFixed(1)}, ${s.z.toFixed(1)}) inside ${b.name} [${b.min.map((v) => v.toFixed(1))}]-[${b.max.map((v) => v.toFixed(1))}]`); }
    t.diagnostic(`${tier}: ${samples.length} samples, ${boxes.length} buildings, ${bad.length} inside`);
    assert.deepEqual(bad.slice(0, 10), [], `${bad.length} samples inside a building`);
    assert.deepEqual(errors, []);
  });
}
