/**
 * PG1's November 2026 post (scripts/social-build.mjs, docs/social/2026-11/):
 * the words follow the house rules (white label: PG1, PG1 Studio, PG1 Sound
 * only; the Project-Gifted1™ mark and no © line; no uptime or outage talk;
 * never "safe"; no figures but version numbers), the cut runs 20 to 30
 * seconds, and the committed files have the sizes the post needs.
 * Run with: node --test tests/social-copy.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HIGHLIGHTS, SLIDES, STORY, COVER, CUT, MARK, POST_DATE, cutSeconds } from '../scripts/social-build.mjs';
import { SHOTS } from '../lib/showcase/shots.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'docs', 'social', '2026-11');
const BUILD = readFileSync(join(ROOT, 'scripts', 'social-build.mjs'), 'utf8');
const words = [...SLIDES.flatMap((h) => [h.tag, h.title, h.line, ...(h.items || []).flatMap((i) => [i.name, i.text])]), COVER.tag, COVER.title, COVER.line, ...CUT.map((c) => c[3] || ''), ...SHOTS.map((s) => s.title)].join('\n');

test('white label, the mark, and the house rules on every word of the post', () => {
  const providers = /elevenlabs|google|gemini|veo\b|lyria|replicate|kling|cartesia|flux|openrouter|openai|anthropic|claude/i;
  assert.doesNotMatch(words, providers);
  assert.doesNotMatch(BUILD.replace(/^\/\/.*$/gm, ''), providers, 'nor anywhere in the build script');
  assert.doesNotMatch(words, /\bsafe\b|\bsafely\b|\bsafety\b/i, 'a clean result is "no findings"');
  assert.doesNotMatch(words, /uptime|downtime|outage|incident/i);
  assert.doesNotMatch(words + BUILD, /©|copyright/i);
  assert.doesNotMatch(words, /\(c\)/i);
  assert.equal(MARK, 'Project-Gifted1™');
  assert.doesNotMatch(words, /Project-Gifted1(?!™)/, 'the mark always carries ™');
});

test('no figures but version numbers (and the names that carry digits)', () => {
  const stripped = words.replace(/\bv?\d+\.\d+(?:\.\d+)?\b/g, '').replace(/\bPG1\b|Gifted1|Ed25519|c\. 1610|23 November 2026|November 2026|\bA2A\b|\b3D\b/g, '');
  assert.doesNotMatch(stripped, /\d/, stripped.match(/.*\d.*/) && stripped.match(/.*\d.*/)[0]);
  // The features and their versions, as shipped.
  const byId = Object.fromEntries(SLIDES.map((h) => [h.id, h]));
  assert.match(byId['check-repo-trap'].tag, /v1\.22\.0/);
  assert.match(byId['check-agent-message'].tag, /v1\.21\b/);
  assert.equal(byId['a2a-1-0'].title, 'A2A 1.0');
  assert.doesNotMatch(byId['a2a-1-0'].line, /registry/i, 'no listing claim the repo cannot back');
  assert.deepEqual(SLIDES.map((h) => h.title), ['What PG1 shipped', "What's new", 'check_repo_trap', 'check_agent_message', 'A2A 1.0', 'PG1 City', 'PG1 Universe', 'Passkey sign-in + signed results', 'Link in bio']);
  // Each slide over its own still; the passkey slide's city frame differs from slides 1, 2 and 5.
  const stills = SLIDES.filter((h) => h.still).map((h) => h.still);
  assert.equal(new Set(stills).size, stills.length);
});

test('the cut: every shot and every highlight, 20 to 30 seconds', () => {
  const s = cutSeconds();
  assert.ok(s >= 20 && s <= 30, `${s} s`);
  assert.deepEqual([...new Set(CUT.filter((c) => c[0] === 'shot').map((c) => c[1]))].sort(), SHOTS.map((x) => x.id).sort());
  assert.deepEqual(CUT.filter((c) => c[0] === 'card').map((c) => c[1]).sort(), HIGHLIGHTS.map((h) => h.id).sort());
  assert.equal(SLIDES.length, 9);
});

test('23 November 2026: the date on the cover, the Story and the wide cover; a recap; summaries a phone can read', () => {
  assert.equal(POST_DATE, '23 November 2026');
  const cover = SLIDES[0];
  assert.equal(cover.id, 'cover'); assert.equal(cover.tag, POST_DATE); assert.equal(COVER.tag, POST_DATE);
  assert.equal(STORY.slide, 'cover', 'the Story is the cover slide');
  // The recap comes right after the cover: all six features, one line each.
  const recap = SLIDES[1];
  assert.equal(recap.id, 'recap'); assert.equal(recap.title, "What's new"); assert.equal(recap.still, null);
  assert.deepEqual(recap.items.map((i) => i.name), ['check_repo_trap', 'check_agent_message', 'A2A 1.0', 'PG1 City', 'PG1 Universe', 'Passkey + signed results']);
  for (const i of recap.items) assert.ok(i.text.length <= 70, `${i.name}: one line`);
  // Every feature slide: a 2-3 sentence summary, at most about 40 words, set at 30 px or more.
  for (const h of SLIDES.filter((x) => x.still && x.id !== 'cover')) {
    const n = h.line.split(/\s+/).filter(Boolean).length;
    assert.ok(n >= 20 && n <= 42, `${h.id}: ${n} words`);
    const sentences = h.line.split(/[.!?](?:\s|$)/).filter((x) => x.trim()).length;
    assert.ok(sentences >= 2 && sentences <= 3, `${h.id}: ${sentences} sentences`);
  }
  assert.match(BUILD, /const lineSize = h\.line\.length > 120 \? 34 : 40;/);
  assert.match(BUILD, /\.t\{font-size:30px/);
  // The City slide: probes and checks, never attacks or hostile (they are not blocked attacks).
  const city = SLIDES.find((h) => h.id === 'pg1-city');
  assert.doesNotMatch(city.line, /attack|hostile/i);
  assert.match(city.line, /probes, checks/);
  // A2A: what the code shows (its own 1.0 tests and the official SDK), no registry claim.
  assert.doesNotMatch(SLIDES.find((h) => h.id === 'a2a-1-0').line, /registry|conformance tests/i);
});

const png = (f) => { const b = readFileSync(f); assert.equal(b.toString('hex', 0, 8), '89504e470d0a1a0a'); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };
test('the committed files: nine 1080 x 1350 slides, the Story at 1080 x 1920, a 1200 x 675 cover, highlights.mp4', { skip: !existsSync(join(DIR, 'highlights.mp4')) && 'not built yet' }, () => {
  for (const h of SLIDES) assert.deepEqual(png(join(DIR, h.file)), { w: 1080, h: 1350 }, h.file);
  assert.deepEqual(png(join(DIR, STORY.file)), { w: 1080, h: 1920 });
  assert.deepEqual(png(join(DIR, COVER.file)), { w: 1200, h: 675 });
  const mp4 = readFileSync(join(DIR, 'highlights.mp4'));
  assert.equal(mp4.toString('latin1', 4, 8), 'ftyp');
  assert.ok(statSync(join(DIR, 'highlights.mp4')).size > 200000);
  const i = mp4.indexOf('tkhd');
  assert.ok(i > 0);
  const v = mp4[i + 4]; const off = i + 4 + (v === 1 ? 88 : 76);
  assert.deepEqual([mp4.readUInt32BE(off) >>> 16, mp4.readUInt32BE(off + 4) >>> 16], [1080, 1920]);
});
