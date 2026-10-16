/**
 * Item 10, white label: client-facing output (chat offers, proposals,
 * PDFs) never names a provider or a model. It says "PG1 Studio" or "PG1
 * Sound" and describes the capability. Provider names stay in the internal
 * registry, the report and operator-only views.
 *
 * The scan below uses its own list of names, independent of
 * lib/whiteLabel.mjs, so a name the module forgets still fails the test.
 *
 * Run with: node --test tests/white-label.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { whiteLabel, namesProvider, isOfferRequest, splitsName, stripProviderLinks, withTrademark, TRADEMARK, BRAND_LINE } from '../lib/whiteLabel.mjs';
import { renderPdf } from '../lib/pdf/render.mjs';
import { PDFDocument } from 'pdf-lib';
import { prepareClientDocument } from '../lib/clientDocs.mjs';
import { handlePdfCommand } from '../lib/pdf/chat.mjs';
import { offersDirective, RIGHTS_WORDING, SAFETY_WORDING, licenceReviewNote, offerNote, offerViolations } from '../lib/capabilities/offers.mjs';
import { createReplyScrubber } from '../lib/chatStream.mjs';
import { pdfText } from './helpers/pdfText.mjs';

// Every provider, company and model name PG1 uses or researched.
const SCAN = /\b(?:eleven\s?labs|eleven\s+(?:music|v\d)|google|gemini|veo|lyria|imagen|replicate|kling|kwaivgi|kuaishou|topaz|cartesia|sonic-\d|flux|kontext|black\s+forest\s+labs|demucs|htdemucs|basic-pitch|deepmind|vertex|omni\s+flash|nano\s+banana|wan\s+2\.\d|real-?esrgan|rife|chirp|whisper|chatterbox|synthid|anthropic|claude|openai|gpt-?\d|openrouter)\b/i;

function assertClean(text, where) {
  const m = SCAN.exec(String(text || ''));
  assert.equal(m, null, `${where} names "${m && m[0]}"`);
}

const LEAKY = [
  '# PG1 Studio Short-form Video Packages',
  '',
  '## Short-form video packages',
  '| Tier | Price | Includes |',
  '|---|---|---|',
  '| Creator | $45/month | 8 clips made with Gemini Omni Flash, Kling v2.1 as a fallback |',
  '| Studio | $80/month | 16 clips, music by ElevenLabs (Eleven Music) or Lyria 3.5, voice-over by Cartesia |',
  '',
  '## How it works',
  '- Storyboards and keyframes from FLUX Kontext Pro (Black Forest Labs) on Replicate, or gemini-3.1-flash-image',
  '- Video on Google Veo 3.1 or kwaivgi/kling-v2.1; 4K upscaling with Topaz Labs: custom, on request',
  '- Stems split with Demucs (htdemucs) and MIDI from basic-pitch',
  '- Dialogue with Eleven v3 Text to Dialogue: custom, on request',
  '- Pricing details: [Replicate pricing](https://replicate.com/pricing), https://elevenlabs.io/pricing/api and ai.google.dev',
  '',
  '## Rights',
  'Full commercial use rights, subject to Google\'s generated-content terms and the ElevenLabs terms of service.'
].join('\n');

test('whiteLabel: provider and model names become PG1 Studio or PG1 Sound; the capability stays described', () => {
  assert.equal(whiteLabel('Clips made with Kling on Replicate'), 'Clips made with PG1 Studio');
  assert.equal(whiteLabel('Music by ElevenLabs, voice-over by Cartesia'), 'Music by PG1 Sound, voice-over by PG1 Sound');
  assert.equal(whiteLabel('Rendered with Gemini Omni 1.1 Flash via the Gemini API'), 'Rendered with PG1 Studio');
  assert.equal(whiteLabel('Stills from flux-kontext-pro and gemini-3.1-flash-image'), 'Stills from PG1 Studio');
  assert.equal(whiteLabel('The google/lyria-2 model on Replicate'), 'The PG1 Sound model');
  assert.equal(whiteLabel('Subject to Google\'s terms.'), 'Subject to provider terms.');
  assert.equal(whiteLabel('Google won\'t claim ownership of the output.'), 'The provider won\'t claim ownership of the output.', 'a company is "the provider", never PG1');
  assert.equal(whiteLabel('See [Replicate pricing](https://replicate.com/pricing) and https://example.org/kling-review'), 'See the provider pricing and https://example.org/kling-review', 'provider links go; other URLs are kept byte for byte');
  assert.equal(stripProviderLinks('Docs at ai.google.dev and example.org'), 'Docs at the provider\'s site and example.org');
  assert.equal(whiteLabel('Creator: $45/month for 8 clips'), 'Creator: $45/month for 8 clips', 'nothing to change');
  assert.equal(namesProvider('PG1 Studio and PG1 Sound'), false);
  assert.equal(splitsName('Music by Eleven'), true);
  assert.equal(splitsName('Music by PG1'), false);
  assert.equal(isOfferRequest('price three video packages for a bakery'), true);
  assert.equal(isOfferRequest('which engine made that clip?'), false);
});

test('whiteLabel: text model ids, OpenRouter and ElevenLabs music ids are replaced whole and cleanly', () => {
  // Never a fragment such as "the provider-opus-5-5".
  assert.equal(whiteLabel('Written by claude-opus-5-5 overnight.'), 'Written by PG1 overnight.');
  assert.equal(whiteLabel('Made by claude-opus-5-5.'), 'Made by PG1.', 'a full stop after an id stays');
  assert.equal(whiteLabel('Tried claude-sonnet-5-5 and claude-haiku-4-5-20251001.'), 'Tried PG1.');
  assert.equal(whiteLabel('The anthropic/claude-opus-5-5 model'), 'The PG1 model');
  assert.equal(whiteLabel('Claude Opus 5.5 wrote the script'), 'PG1 wrote the script');
  assert.equal(whiteLabel("claude-opus-5-5's reply"), "PG1's reply");
  assert.equal(whiteLabel('Routed via OpenRouter and openrouter/auto.'), 'Routed via PG1.');
  assert.equal(whiteLabel('openai/gpt-5-mini wrote it'), 'PG1 wrote it');
  assert.equal(whiteLabel('Used gpt-5-mini.'), 'Used PG1.');
  assert.equal(whiteLabel('Track by music_v2_5.'), 'Track by PG1 Sound.');
  assert.equal(whiteLabel('ElevenLabs music_v2_5 track'), 'PG1 Sound track');
  assert.equal(whiteLabel('Ran gemini-3.6-flash.'), 'Ran PG1 Studio.');
  for (const t of ['claude-opus-5-5', 'anthropic/claude-opus-5-5', 'openrouter/auto', 'OpenRouter', 'music_v2_5', 'gpt-5', 'Claude Sonnet 5']) {
    const out = whiteLabel(`x ${t} y`);
    assert.equal(namesProvider(out), false, `${t} -> ${out}`);
    assert.doesNotMatch(out, /provider-|-\d-\d|_v\d/, `${t} -> ${out}: no fragment left`);
  }
  // Media slugs keep their own labels.
  assert.equal(whiteLabel('The google/lyria-2 model'), 'The PG1 Sound model');
  assert.equal(whiteLabel('A still from google/imagen-4'), 'A still from PG1 Studio');
});

test('the wording that reaches clients is generic: offers, rights, safety, notes', () => {
  assertClean(RIGHTS_WORDING, 'the rights wording');
  assert.match(RIGHTS_WORDING, /subject to provider terms/);
  assertClean(SAFETY_WORDING, 'the safety wording');
  assertClean(offersDirective(), 'the [OFFERS] block');
  assertClean(offerNote(offerViolations('Includes IP indemnification, 8K masters and voice cloning.')), 'the offer check');
  assertClean(licenceReviewNote('## Packages\n| Tier | Price |\n|---|---|\n| Starter | $25 | 4 video clips with music and voice-over |'), 'the licence note');
});

test('prepareClientDocument white-labels every line and says so to the operator only', () => {
  const p = prepareClientDocument({ title: 'PG1 Studio Short-form Video Packages', markdown: LEAKY.split('\n').slice(2).join('\n') });
  assertClean(p.title, 'the title');
  assertClean(p.markdown, 'the document');
  assert.match(p.markdown, /\| Creator \| \$45\/month \| 8 clips made with PG1 Studio/);
  assert.match(p.markdown, /Full commercial use rights, subject to provider terms/);
  assert.ok(p.changes.some((c) => /Replaced provider and model names on \d+ lines with PG1 Studio or PG1 Sound \(white label\)/.test(c)));
});

test('scan: client PDFs made from chat (/pdf, "make this a PDF") name no provider or model', async () => {
  const uploads = [];
  const fetchImpl = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('/storage/v1/object/sign/')) return Response.json({ signedURL: '/object/sign/pg1-vault/documents/x.pdf?token=t' });
    if (u.includes('/storage/v1/object/')) { uploads.push(options.body); return Response.json({ Key: 'ok' }); }
    if (u.includes('/rest/v1/pg1_documents')) return new Response(JSON.stringify([JSON.parse(options.body)]), { status: 201 });
    throw new Error('Unexpected network call in test: ' + u);
  };
  const common = { isOperator: true, supUrl: 'https://supabase.test', supKey: 'k', fetchImpl, now: new Date('2026-10-14T00:00:00Z') };
  const written = await handlePdfCommand({ ...common, text: '/pdf the video package proposal for the client', writeDocument: async () => ({ markdown: LEAKY }) });
  const fromReply = await handlePdfCommand({ ...common, text: 'make this a PDF', sourceText: LEAKY });
  assert.equal(uploads.length, 2);
  for (const [i, r] of [written, fromReply].entries()) {
    const { title, text } = await pdfText(uploads[i]);
    assertClean(title, `PDF ${i + 1} title`);
    assertClean(text, `PDF ${i + 1}`);
    assertClean(r.pdf.title, `PDF ${i + 1} card`);
    assert.match(text, /PG1 Studio/);
    assert.match(text, /PG1 Sound/);
    assert.match(text, /Creator \$45\/month/);
  }
  // The operator's own document (not for a client) keeps the names.
  uploads.length = 0;
  await handlePdfCommand({ ...common, text: '/pdf my internal engine cost notes', writeDocument: async () => ({ markdown: '# Engine notes\n\n- Kling on Replicate: $0.30 a clip' }) });
  assert.match((await pdfText(uploads[0])).text, /Kling on Replicate/);
});

test('scan: a chat offer names no provider or model, streamed (with a name split across chunks) and JSON', async () => {
  const { default: chatHandler, __clearAuthRateLimitState } = await import('../api/chat.mjs');
  const { createSseParser } = await import('../lib/chatStream.mjs');
  const saved = { ...process.env };
  const savedFetch = globalThis.fetch;
  const REPLY = '## Bakery video packages\n| Tier | Price |\n|---|---|\n| Creator | $45/month |\n| Studio | $80/month |\n\nClips are made with Kling on Replicate and Gemini Omni Flash, with music from Eleven Music and voice-over by Cartesia. Stems come from Demucs.';
  try {
    Object.assign(process.env, { USER_API_KEY: 'test-operator', USER_API_PASS: 'test-secret-pass', GEMINI_API_KEY: 'stub-gemini-key' });
    for (const k of ['ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'CARTESIA_API_KEY']) delete process.env[k];
    __clearAuthRateLimitState();
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (!u.includes('generativelanguage.googleapis.com')) throw new Error('Unexpected network call in test: ' + u);
      if (u.includes('streamGenerateContent')) {
        // Cut mid-name: "...music from Eleven" | " Music and voice-over..."
        const at = REPLY.indexOf('Eleven') + 'Eleven'.length;
        const parts = [REPLY.slice(0, at), REPLY.slice(at)];
        return new Response(parts.map((t) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] })}\n\n`).join('') + `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }] })}\n\n`);
      }
      return Response.json({ candidates: [{ content: { parts: [{ text: REPLY }] }, finishReason: 'STOP' }] });
    };
    const mk = () => ({ statusCode: null, headers: {}, jsonBody: null, chunks: [], setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, status(c) { this.statusCode = c; return this; }, json(b) { this.jsonBody = b; return this; }, write(c) { this.chunks.push(String(c)); return true; }, end() { return this; }, on() {} });
    const req = (body, ip) => ({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: ip }, body: { user: 'test-operator', pass: 'test-secret-pass', ...body } });
    const json = mk();
    await chatHandler(req({ prompt: 'price video packages for a bakery client' }, '10.91.0.1'), json);
    assertClean(json.jsonBody.reply, 'the JSON offer');
    assert.match(json.jsonBody.reply, /Clips are made with PG1 Studio, with music from PG1 Sound and voice-over by PG1 Sound\. Stems come from PG1 Sound\./);
    const streamed = mk();
    await chatHandler(req({ prompt: 'price video packages for a bakery client', stream: true }, '10.91.0.2'), streamed);
    const events = [];
    const parser = createSseParser(({ data }) => events.push(JSON.parse(data)));
    parser.push(streamed.chunks.join(''));
    parser.end();
    const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
    assert.ok(text.length > 100, 'the reply streamed');
    assertClean(text, 'the streamed offer');
    // An operator question that is not an offer is an operator-only view:
    // it is not rewritten.
    const own = mk();
    await chatHandler(req({ prompt: 'what did the last render cost?' }, '10.91.0.3'), own);
    assert.match(own.jsonBody.reply, /Kling on Replicate/);
  } finally {
    process.env = saved;
    globalThis.fetch = savedFetch;
  }
});

test('the stream scrubber holds a name that could continue, so "Eleven | Music" is white-labelled whole', () => {
  let out = '';
  const s = createReplyScrubber((t) => { out += t; }, { redact: (t) => ({ text: whiteLabel(t), removed: [] }), keepTogether: splitsName });
  const reply = `${'Our packages cover short films for small brands. '.repeat(3)}Music comes from Eleven`;
  s.push(reply);
  s.push(` Music, and the clips from Kling on Replicate.${' More text to push the hold window along.'.repeat(4)}`);
  s.flush();
  assertClean(out, 'the scrubbed stream');
  assert.match(out, /Music comes from PG1 Sound, and the clips from PG1 Studio\./);
});

test('provider names stay in the internal registry and the report', () => {
  const report = readFileSync(new URL('../docs/studio-sound-phase1.md', import.meta.url), 'utf8');
  assert.match(report, /ElevenLabs/);
  assert.match(report, /gemini-omni-1\.1-flash/);
  const registry = readFileSync(new URL('../lib/capabilities/registry.json', import.meta.url), 'utf8');
  assert.match(registry, /kwaivgi\/kling-v2\.1/);
});

// --- the trademark ------------------------------------------------------------------

test('trademark: the company is always written Project-Gifted1™, and white labelling never touches it', () => {
  assert.equal(TRADEMARK, 'Project-Gifted1™');
  assert.equal(BRAND_LINE, 'PG1 Studio and PG1 Sound are services of Project-Gifted1™.');
  for (const t of ['Project Gifted1', 'Project-Gifted1', 'project-gifted1', 'Project-Gifted1 (TM)', 'Project-Gifted1&trade;', 'Project-Gifted1™']) assert.equal(withTrademark(`By ${t}.`), 'By Project-Gifted1™.', t);
  assert.equal(withTrademark('See https://github.com/Project-Gifted1/pg1-ai-agent by Project-Gifted1.'), 'See https://github.com/Project-Gifted1/pg1-ai-agent by Project-Gifted1™.', 'a URL is never changed');
  assert.equal(whiteLabel(`${BRAND_LINE} Clips by Kling.`), `${BRAND_LINE} Clips by PG1 Studio.`);
  assert.match(offersDirective(), /Trademark: PG1 Studio and PG1 Sound are services of Project-Gifted1™; write the company exactly as Project-Gifted1™, with the ™/);
});

test('trademark: every PDF page footer and the document author carry Project-Gifted1™', async () => {
  const r = await renderPdf({ title: 'Long', markdown: Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1} with some words to fill the page.`).join('\n\n') });
  assert.ok(r.pages >= 2);
  const { text } = await pdfText(r.bytes);
  assert.equal(text.split('Project-Gifted1™ · Made with PG1 ·').length - 1, r.pages, 'one footer mark per page');
  const doc = await PDFDocument.load(r.bytes, { updateMetadata: false });
  assert.equal(doc.getAuthor(), 'Project-Gifted1™');
  assert.equal(doc.getProducer(), 'PG1');
});

test('trademark: a client proposal names Project-Gifted1™ in its subtitle and closes with the brand line', () => {
  const p = prepareClientDocument({ title: 'Video packages', markdown: '## Short-form video packages\n| Tier | Price |\n|---|---|\n| Creator | $45/month |\n\nA Project Gifted1 production.' });
  assert.match(p.markdown, /A Project-Gifted1™ production\./);
  assert.ok(p.markdown.endsWith(`\n\n${BRAND_LINE}`));
  assert.equal(prepareClientDocument({ title: 'x packages', markdown: `## X packages\n- Creator: $45\n\n${BRAND_LINE}` }).markdown.split(BRAND_LINE).length, 2, 'never twice');
});

test('trademark: a priced chat offer carries Project-Gifted1™ (JSON and streamed); an operator question does not get it', async () => {
  const { default: chatHandler, __clearAuthRateLimitState } = await import('../api/chat.mjs');
  const { createSseParser } = await import('../lib/chatStream.mjs');
  const saved = { ...process.env };
  const savedFetch = globalThis.fetch;
  let reply = '## Bakery video packages\n| Tier | Price |\n|---|---|\n| Creator | $45/month |\n| Studio | $80/month |';
  try {
    Object.assign(process.env, { USER_API_KEY: 'test-operator', USER_API_PASS: 'test-secret-pass', GEMINI_API_KEY: 'stub-gemini-key' });
    for (const k of ['ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'CARTESIA_API_KEY']) delete process.env[k];
    __clearAuthRateLimitState();
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (!u.includes('generativelanguage.googleapis.com')) throw new Error('Unexpected network call in test: ' + u);
      const cand = { content: { parts: [{ text: reply }] }, finishReason: 'STOP' };
      if (u.includes('streamGenerateContent')) return new Response(`data: ${JSON.stringify({ candidates: [cand] })}\n\n`);
      return Response.json({ candidates: [cand] });
    };
    const mk = () => ({ statusCode: null, headers: {}, jsonBody: null, chunks: [], setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, status(c) { this.statusCode = c; return this; }, json(b) { this.jsonBody = b; return this; }, write(c) { this.chunks.push(String(c)); return true; }, end() { return this; }, on() {} });
    const req = (body, ip) => ({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: ip }, body: { user: 'test-operator', pass: 'test-secret-pass', ...body } });
    const json = mk();
    await chatHandler(req({ prompt: 'price video packages for a bakery client' }, '10.92.0.1'), json);
    assert.ok(json.jsonBody.reply.includes(BRAND_LINE));
    const streamed = mk();
    await chatHandler(req({ prompt: 'price video packages for a bakery client', stream: true }, '10.92.0.2'), streamed);
    const events = [];
    const parser = createSseParser(({ data }) => events.push(JSON.parse(data)));
    parser.push(streamed.chunks.join(''));
    parser.end();
    assert.ok(events.filter((e) => e.type === 'text').map((e) => e.text).join('').includes(BRAND_LINE));
    // A reply that already writes the company gets it marked, not a second line.
    reply = '## Bakery video packages\n- Creator: $45/month\n\nPrepared by Project Gifted1.';
    const named = mk();
    await chatHandler(req({ prompt: 'price video packages for a bakery client' }, '10.92.0.3'), named);
    assert.match(named.jsonBody.reply, /Prepared by Project-Gifted1™\./);
    assert.ok(!named.jsonBody.reply.includes(BRAND_LINE));
    // Not an offer: no brand line.
    const own = mk();
    await chatHandler(req({ prompt: 'what did the last render cost?' }, '10.92.0.4'), own);
    assert.ok(!own.jsonBody.reply.includes(BRAND_LINE));
  } finally {
    process.env = saved;
    globalThis.fetch = savedFetch;
  }
});
