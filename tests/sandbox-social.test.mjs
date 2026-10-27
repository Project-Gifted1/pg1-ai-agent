/**
 * Conversations (lib/sandbox/society.mjs): people who meet sometimes stop,
 * stand together and talk, taking turns, then go on their way. More often
 * at the same place than passing in the street. Deterministic from the seed.
 *
 * Run with: node --test tests/sandbox-social.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, stepWorld } from '../lib/sandbox/engine.mjs';
import { templateSpec } from '../lib/sandbox/templates.mjs';
import { containsBanned } from '../lib/sandbox/blind.mjs';

// The universe, step by step: every conversation as it went.
const UNI = templateSpec('universe');
const talks = new Map();      // "a|b" -> { lines: [{ tick, who, to, text }], positions: [[pa, pb]], steps }
let started = 0;
{
  let st = initialState(UNI);
  for (let t = 1; t <= 1200; t++) {
    const r = stepWorld(UNI, st, 1); st = r.state;
    const idx = new Map(st.entities.map((e) => [e.id, e]));
    for (const e of st.entities) {
      const o = e.properties.chat_with && idx.get(e.properties.chat_with);
      if (!o || e.id > o.id) continue;
      const key = `${e.id}|${o.id}|${e.properties.chat_start}`;
      if (!talks.has(key)) { talks.set(key, { lines: [], positions: [], a: e.id, b: o.id }); started += 1; }
      talks.get(key).positions.push([{ ...e.position }, { ...o.position }]);
      for (const ev of r.events) if (ev.kind === 'talk' && (ev.ref === e.id || ev.ref === o.id)) talks.get(key).lines.push({ tick: ev.tick, who: ev.ref, text: ev.summary.slice(ev.summary.indexOf(': "') + 3, -1) });
    }
  }
}

test('people stop to talk: hundreds of conversations in 1,200 steps of the universe', () => {
  assert.ok(started >= 200, `${started} conversations`);
});

test('in a conversation the two stand together, about a metre apart, and do not walk off', () => {
  for (const { positions } of talks.values()) {
    for (const [a, b] of positions) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) <= 2.01, 'close together');
    // Where they stood when they began is where they stand until it ends (the watchdog may nudge them a little).
    const [a0] = positions[0]; const [aN] = positions[positions.length - 1];
    assert.ok(Math.hypot(a0.x - aN.x, a0.y - aN.y) < 2, 'stays put');
  }
});

test('they take turns, nobody repeats a line within a conversation, and partners talk like partners', () => {
  let turns = 0;
  for (const { lines, a, b } of talks.values()) {
    for (let i = 1; i < lines.length; i++) if (lines[i].who !== lines[i - 1].who) turns += 1;
    const texts = lines.map((l) => l.text);
    // (a passing greeting just before may be the same as the opening)
    assert.equal(new Set(texts.slice(1)).size, texts.slice(1).length, `no repeats: ${texts.join(' / ')}`);
    for (const l of lines) assert.equal(containsBanned(l.text), false, l.text);
    void a; void b;
  }
  assert.ok(turns > 100, `${turns} changes of speaker`);
  // Nobody tells their own partner how they and their partner are doing.
  let st = initialState(UNI);
  for (let i = 0; i < 6; i++) {
    const r = stepWorld(UNI, st, 100); st = r.state;
    const idx = new Map(st.entities.map((e) => [e.id, e]));
    for (const ev of r.events.filter((x) => x.kind === 'talk')) {
      const who = idx.get(ev.ref); if (!who || !who.properties.partner) continue;
      const partner = idx.get(who.properties.partner); if (!partner) continue;
      assert.ok(!ev.summary.includes(`to ${partner.properties.name} ${partner.properties.family || ''}`.trim() + `: "${partner.properties.name} and I`), ev.summary);
    }
  }
});

test('a question gets an answer', () => {
  let asked = 0; let answered = 0;
  for (const { lines } of talks.values()) for (let i = 0; i + 1 < lines.length; i++) {
    if (!/How have you been|dinner tonight/.test(lines[i].text) || lines[i + 1].who === lines[i].who) continue;
    asked += 1;
    if (/Not bad|Busy, but good|Tired, honestly|Soup|Your choice|cook together/.test(lines[i + 1].text)) answered += 1;
  }
  assert.ok(asked > 0, 'questions were asked');
  assert.equal(answered, asked, `${answered} of ${asked} answered`);
});

test('deterministic: same world and seed, same conversations', () => {
  const run = () => { let st = initialState(UNI); for (let i = 0; i < 3; i++) st = stepWorld(UNI, st, 100).state; return st.entities.map((e) => `${e.id}:${e.properties.chat_with || ''}:${e.properties.saying || ''}`).join(','); };
  assert.equal(run(), run());
});
