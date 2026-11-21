/**
 * PG1 Showcase render, smoke test: two frames of one shot (the planet and
 * its star, the quickest to load) through the whole path of
 * scripts/showcase-render.mjs at a small size: the local server, the
 * showcase profile on a desktop viewport, the stepped clock, the scripted
 * camera, the PNG frames and the ffmpeg encode (H.264, yuv420p). The full
 * render is .github/workflows/showcase.yml, never CI.
 * Skipped (not failed) when Playwright's Chromium or ffmpeg is missing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import os from 'node:os';

let skip = false;
try {
  const { chromium } = await import('playwright');
  if (!existsSync(chromium.executablePath()) && !existsSync('/opt/pw-browsers/chromium')) skip = `Chromium is not installed at ${chromium.executablePath()}`;
} catch (e) { skip = 'playwright is not installed (npm install)'; }
if (!skip && spawnSync('ffmpeg', ['-version']).status !== 0) skip = 'ffmpeg is not installed';

test('showcase render: two frames of a shot, encoded to H.264', { skip, timeout: 900000 }, async (t) => {
  const out = mkdtempSync(join(os.tmpdir(), 'pg1-showcase-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const { main } = await import('../../scripts/showcase-render.mjs');
  const m = await main(['--shots', 'deep-space', '--size', '320x568', '--frames', '2', '--warmup', '0', '--out', out]);
  assert.equal(m.profile, 'showcase');
  assert.equal(m.shots.length, 1);
  const s = m.shots[0];
  assert.equal(s.id, 'deep-space'); assert.equal(s.frames, 2);
  assert.deepEqual(s.page_errors, []);
  // Drawn as a showcase on a desktop, every pixel of the output (checked on every frame by the script too).
  for (const d of [s.diagnostics.first, s.diagnostics.last]) {
    assert.deepEqual([d.tier, d.profile, d.coarse, d.renderScale, d.governor, d.probe, d.dpr], ['showcase', 'showcase', false, 1, 'off', 'off', 1]);
    assert.deepEqual(d.drawingBuffer, [320, 568]);
    assert.ok(d.deviceMemory >= 8 && !d.touchPoints);
    assert.ok(typeof d.webglRenderer === 'string' && d.webglRenderer.length > 0);
  }
  const png = readFileSync(join(out, 'deep-space.png'));
  assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [320, 568]);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=codec_name,pix_fmt,width,height,nb_read_frames', '-of', 'json', join(out, 'deep-space.mp4')], { encoding: 'utf8' });
  const st = JSON.parse(probe.stdout).streams[0];
  assert.deepEqual([st.codec_name, st.pix_fmt, st.width, st.height, Number(st.nb_read_frames)], ['h264', 'yuv420p', 320, 568, 2]);
  assert.ok(existsSync(join(out, 'manifest.json')));
});
