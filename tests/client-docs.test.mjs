/**
 * What PG1 puts in front of a client (items 2-9 of the Studio + Sound
 * brief, carried into Phase 1):
 *
 *   2  safety filters described the same way, never "no filters"
 *   3  rights wording: no ownership transfer, exclusivity or indemnity
 *   4  sources shown with their real URLs; a grounding redirect is
 *      followed or left out, never shown
 *   5  a market figure with no source is labelled as PG1's estimate
 *   6  tier names stay the same through a thread, or the change is named
 *   7  no "Agreement" (contract, terms) titles on documents
 *   8  no private context (engines, PG1's costs, settings, ids, operator
 *      notes) in a client document
 *   9  PDF bullets and indentation: nested lists keep their level, markers
 *      sit beside the text, numbers line up
 *
 * Run with: node --test tests/client-docs.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSources, isGroundingRedirect, clientTitle, clientHeadings, hasAgreementTitle, isClientDocument, scrubPrivateContext, prepareClientDocument } from '../lib/clientDocs.mjs';
import { sourcesNote, unsourcedMarketFigures, UNSOURCED_NOTE, tierChanges, tierChangeNote, mergeFigures, SOURCED_FIGURES_DIRECTIVE } from '../lib/replyFacts.mjs';
import { RIGHTS_WORDING, SAFETY_WORDING, offerViolations } from '../lib/capabilities/offers.mjs';
import { markdownToBlocks } from '../lib/pdf/markdown.mjs';
import { renderPdf } from '../lib/pdf/render.mjs';
import { handlePdfCommand, PDF_WRITE_SYSTEM } from '../lib/pdf/chat.mjs';

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
async function pdfText(bytes) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, isEvalSupported: false, verbosity: 0 }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) out.push((await (await doc.getPage(i)).getTextContent()).items.map((it) => it.str).join(' '));
  return { title: (await doc.getMetadata()).info.Title, text: out.join(' ').replace(/\s+/g, ' ') };
}

// --- item 4 -----------------------------------------------------------------------

const REDIRECT = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbCdEf123';

test('item 4: a grounding redirect is followed once (HEAD, no redirect follow) and shown as its real URL', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts.method, redirect: opts.redirect });
    if (url === REDIRECT) return new Response(null, { status: 302, headers: { location: 'https://www.example.org/video-rates?ref=1' } });
    return new Response(null, { status: 404 });
  };
  const out = await resolveSources([{ url: REDIRECT, title: 'example.org' }, { url: 'https://direct.example/page', title: 'direct' }], { fetchImpl });
  assert.deepEqual(out, [{ url: 'https://www.example.org/video-rates?ref=1', title: 'example.org' }, { url: 'https://direct.example/page', title: 'direct' }]);
  assert.deepEqual(calls, [{ url: REDIRECT, method: 'HEAD', redirect: 'manual' }], 'only the redirect is requested, and never followed blindly');
  assert.equal(isGroundingRedirect(REDIRECT), true);
});

test('item 4: a redirect that fails, times out or points at another redirect or http is left out, never shown', async () => {
  const cases = [
    async () => { throw new Error('network'); },
    async () => new Response(null, { status: 500 }),
    async () => new Response(null, { status: 302, headers: { location: 'http://insecure.example/' } }),
    async () => new Response(null, { status: 302, headers: { location: REDIRECT } }),
    async () => new Response(null, { status: 302, headers: { location: 'https://www.google.com/url?q=x' } }),
    (url, opts) => new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))))
  ];
  for (const fetchImpl of cases) {
    const out = await resolveSources([{ url: REDIRECT, title: 't' }], { fetchImpl, timeoutMs: 50 });
    assert.deepEqual(out, []);
  }
  // With every source dropped, a "based on search" claim is labelled.
  assert.match(sourcesNote({ text: 'Based on web search data, Creator: $45/month', sources: [] }), /no source for the figures above/);
  assert.match(SOURCED_FIGURES_DIRECTIVE, /never a redirect or search-results link/);
});

test('item 4: through the chat, the sources list shows the real URL and no grounding redirect', async () => {
  const { default: chatHandler, __clearAuthRateLimitState } = await import('../api/chat.mjs');
  const saved = { ...process.env };
  const savedFetch = globalThis.fetch;
  try {
    Object.assign(process.env, { USER_API_KEY: 'test-operator', USER_API_PASS: 'test-secret-pass', GEMINI_API_KEY: 'stub-gemini-key' });
    for (const k of ['ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'CARTESIA_API_KEY']) delete process.env[k];
    __clearAuthRateLimitState();
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u === REDIRECT) return new Response(null, { status: 302, headers: { location: 'https://rates.example/video' } });
      if (!u.includes('generativelanguage.googleapis.com')) throw new Error('Unexpected network call in test: ' + u);
      return Response.json({ candidates: [{ content: { parts: [{ text: '- Creator: $45/month\n- Studio: $80/month' }] }, finishReason: 'STOP', groundingMetadata: { groundingChunks: [{ web: { uri: REDIRECT, title: 'rates.example' } }] } }] });
    };
    const res = { statusCode: null, headers: {}, jsonBody: null, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, status(c) { this.statusCode = c; return this; }, json(b) { this.jsonBody = b; return this; }, write() { return true; }, end() { return this; }, on() {} };
    await chatHandler({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: '10.89.0.1' }, body: { user: 'test-operator', pass: 'test-secret-pass', prompt: 'what do video packages cost?' } }, res);
    assert.match(res.jsonBody.reply, /1\. \[rates\.example\]\(https:\/\/rates\.example\/video\)/);
    assert.doesNotMatch(res.jsonBody.reply, /vertexaisearch/);
  } finally {
    process.env = saved;
    globalThis.fetch = savedFetch;
  }
});

// --- item 5 -----------------------------------------------------------------------

test('item 5: a market figure with no source is labelled; PG1\'s own prices and linked figures are not', () => {
  for (const t of ['Agencies typically charge $2,000 for a 60-second ad.', 'The industry average is $1,500 per minute.', 'Studies show 73% of buyers watch video first.', 'On average, a corporate video costs $5,000.']) {
    assert.equal(unsourcedMarketFigures(t), true, t);
    assert.equal(sourcesNote({ text: t, sources: [] }), UNSOURCED_NOTE, t);
  }
  for (const t of ['Creator: $45/month for 8 clips.', 'Agencies typically charge $2,000 ([source](https://example.org/rates)).', 'The industry is growing fast.']) {
    assert.equal(unsourcedMarketFigures(t), false, t);
  }
  assert.match(UNSOURCED_NOTE, /no cited source, so treat them as PG1's own estimates/);
});

// --- item 6 -----------------------------------------------------------------------

test('item 6: tier names swapped without a word are named; a renamed set that says so, or an extra item, is not', () => {
  const prev = mergeFigures([], '| Tier | Price |\n|---|---|\n| Starter | $25/month |\n| Creator | $45/month |\n| Studio | $80/month |', 1);
  const swapped = tierChanges(prev, '## Packages\n| Tier | Price |\n|---|---|\n| Basic | $25/month |\n| Pro | $45/month |\n| Studio | $80/month |');
  assert.deepEqual(swapped, { dropped: ['Starter', 'Creator'], added: ['Basic', 'Pro'] });
  assert.equal(tierChangeNote(swapped), '**Tier names changed:** earlier in this thread the tiers were Starter, Creator; this reply uses Basic, Pro without saying why. Keep one set of tier names and the same structure (what each tier includes, its price), or say what changed.');
  assert.equal(tierChanges(prev, '## Packages\nWe renamed the tiers:\n| Tier | Price |\n|---|---|\n| Basic | $25/month |\n| Pro | $45/month |'), null);
  assert.equal(tierChanges(prev, 'Same tiers, plus an add-on:\n- Starter: $25/month\n- Creator: $45/month\n- Rush delivery: $20'), null, 'nothing dropped');
  assert.equal(tierChanges([], '- Basic: $25\n- Pro: $45'), null);
  assert.match(PDF_WRITE_SYSTEM, /same tier names and the same structure for every tier/);
});

// --- item 7 -----------------------------------------------------------------------

test('item 7: an "Agreement", contract or terms title becomes a proposal, headings too', () => {
  assert.equal(clientTitle('PG1 Studio Service Agreement'), 'PG1 Studio Service Proposal');
  assert.equal(clientTitle('Master Services Agreement'), 'Proposal');
  assert.equal(clientTitle('Terms and Conditions'), 'Proposal');
  assert.equal(clientTitle('Video Production Contract'), 'Video Production Proposal');
  assert.equal(clientTitle('Statement of Work: Brand Film'), 'Proposal: Brand Film');
  assert.equal(clientTitle('Short-form video packages'), 'Short-form video packages');
  assert.equal(hasAgreementTitle('Agreement'), true);
  assert.equal(clientHeadings('# Licence Agreement\n\nText about the agreement.\n## Contract terms'), '# Licence Proposal\n\nText about the agreement.\n## Proposal terms');
  assert.match(PDF_WRITE_SYSTEM, /never title it or any heading an agreement, contract, terms or statement of work/);
});

// --- item 8 -----------------------------------------------------------------------

test('item 8: engines, PG1\'s costs and margin, settings, ids and operator notes are left out of a client document', () => {
  const md = [
    '## What you get',
    '- Four 15-second clips a month',
    '- Clips made with Kling on Replicate',
    '- Music by ElevenLabs',
    '- Our cost is about $3 a clip, a 1.5x margin',
    '- Set PG1_FILM_MAX_USD to raise the cap',
    '- Request ID: req_7h3k9q2m1x',
    '**Offer check:** something for the operator',
    '## Price',
    '| Tier | Price |',
    '|---|---|',
    '| Creator | $45/month |'
  ].join('\n');
  const out = scrubPrivateContext(md);
  assert.equal(out.markdown, '## What you get\n- Four 15-second clips a month\n## Price\n| Tier | Price |\n|---|---|\n| Creator | $45/month |');
  assert.deepEqual(out.removed.map((r) => r.id), ['engine_names', 'engine_names', 'internal_costs', 'config_names', 'internal_ids', 'operator_notes']);
});

test('item 8: client documents are told apart from the operator\'s own', () => {
  assert.equal(isClientDocument({ request: 'make the package proposal for the client a PDF' }), true);
  assert.equal(isClientDocument({ request: 'make it a PDF', markdown: '# Video packages\n| Tier | Price |' }), true);
  assert.equal(isClientDocument({ request: 'a PDF of my internal cost breakdown for the packages' }), false);
  assert.equal(isClientDocument({ request: 'make it a PDF', markdown: '# Threat summary\nWallet flagged.' }), false);
});

// --- items 2 and 3 ------------------------------------------------------------------

test('items 2 and 3: the safety and rights wording, and the promises they rule out', () => {
  assert.match(SAFETY_WORDING, /PG1's own content checks and the generation providers' safety filters/);
  assert.match(SAFETY_WORDING, /a declined attempt is not charged twice/);
  assert.match(RIGHTS_WORDING, /may use the delivered files commercially as the licence of each deliverable allows/);
  assert.match(PDF_WRITE_SYSTEM, /does not transfer copyright/);
  assert.deepEqual(offerViolations('Uncensored: any content you want.').map((v) => v.id), ['no_filter_promise']);
  assert.deepEqual(offerViolations('The client receives full copyright and complete ownership.').map((v) => v.id), ['ownership_promise']);
});

test('prepareClientDocument: proposal title, private lines out, forbidden offers out, changes listed for the operator only', () => {
  const p = prepareClientDocument({
    title: 'Video Package Agreement',
    markdown: '## Tiers\n| Tier | Price | Includes |\n|---|---|---|\n| Creator | $45/month | 8 clips |\n| Agency | $900/month | 10 seats and IP indemnification |\n\n## Notes\n- Built on Gemini Omni\n- Sound effects: custom, on request'
  });
  assert.equal(p.title, 'Video Package Proposal');
  assert.equal(p.markdown, '## Tiers\n| Tier | Price | Includes |\n|---|---|---|\n| Creator | $45/month | 8 clips |\n\n## Notes\n- Sound effects: custom, on request');
  assert.equal(p.changes.length, 3);
  assert.match(p.changes[0], /Titled "Video Package Proposal" rather than "Video Package Agreement"/);
  assert.match(p.changes[1], /Left out 1 line that named an engine or provider/);
  assert.match(p.changes[2], /client accounts or seats \(PG1 does not offer it yet\); IP indemnification \(PG1 never offers it\)/);
});

test('/pdf for a client: the PDF is a proposal with no private context; what changed is in the chat reply only', async () => {
  const uploads = [];
  const fetchImpl = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('/storage/v1/object/sign/')) return Response.json({ signedURL: '/object/sign/pg1-vault/documents/x.pdf?token=t' });
    if (u.includes('/storage/v1/object/')) { uploads.push(options.body); return Response.json({ Key: 'ok' }); }
    if (u.includes('/rest/v1/pg1_documents')) return new Response(JSON.stringify([JSON.parse(options.body)]), { status: 201 });
    throw new Error('Unexpected network call in test: ' + u);
  };
  const written = '# Studio Service Agreement\n\n## Packages\n| Tier | Price |\n|---|---|\n| Creator | $45/month |\n| Studio | $80/month |\n\n- Rendered on Replicate (our cost $3 a clip)\n- Exclusive rights to every film\n- 4K delivery: custom, on request';
  const r = await handlePdfCommand({ text: '/pdf the package proposal for the client', isOperator: true, supUrl: 'https://supabase.test', supKey: 'k', fetchImpl, writeDocument: async () => ({ markdown: written }), now: new Date('2026-10-14T00:00:00Z') });
  assert.equal(r.pdf.title, 'Studio Service Proposal');
  const { title, text } = await pdfText(uploads[0]);
  assert.equal(title, 'Studio Service Proposal');
  assert.match(text, /Prepared 2026-10-14/);
  assert.match(text, /Creator \$45\/month/);
  for (const banned of [/Agreement/, /Replicate/, /our cost/i, /Exclusive/i, /PG1 chat/]) assert.doesNotMatch(text, banned);
  assert.match(r.reply, /Titled "Studio Service Proposal" rather than "Studio Service Agreement"/);
  assert.match(r.reply, /exclusive rights \(PG1 never offers it\)/);
  // An operator's own document is left as written.
  uploads.length = 0;
  const own = await handlePdfCommand({ text: '/pdf my internal cost breakdown', isOperator: true, supUrl: 'https://supabase.test', supKey: 'k', fetchImpl, writeDocument: async () => ({ markdown: '# Cost breakdown\n\n- Replicate: $3 a clip' }) });
  assert.equal(own.pdf.title, 'Cost breakdown');
  assert.match((await pdfText(uploads[0])).text, /Replicate: \$3 a clip/);
});

// --- item 9 -----------------------------------------------------------------------

test('item 9: nested lists keep their level and numbering; a blank line before an indented item continues the list', () => {
  const [list, second] = markdownToBlocks('- Creator\n  - 8 clips\n  - 1 revision\n    1. first\n    2. second\n- Studio\n  wrapped text\n\n  - nested after a blank line\n\n1. alone');
  assert.deepEqual(list.entries.map((e) => [e.text, e.level, e.ordered ? e.number : '-']), [
    ['Creator', 0, '-'], ['8 clips', 1, '-'], ['1 revision', 1, '-'], ['first', 2, 1], ['second', 2, 2], ['Studio wrapped text', 0, '-'], ['nested after a blank line', 1, '-']
  ]);
  assert.deepEqual(list.items, list.entries.map((e) => e.text), 'items stays the flat text list');
  assert.deepEqual([second.ordered, second.start, second.items], [true, 1, ['alone']]);
  // "•" bullets are lists too, and numbering restarts under a new parent.
  const [b] = markdownToBlocks('• one\n  1. a\n  2. b\n• two\n  1. c');
  assert.deepEqual(b.entries.map((e) => e.ordered ? e.number : e.text), ['one', 1, 2, 'two', 1]);
});

test('item 9: in the PDF each level indents, markers sit right before the text, and "9." and "10." line up', async () => {
  const md = ['- Level one with a long line that wraps onto a second line inside the page margins of the PDF so wrapping is exercised', '  - Level two', '    - Level three', ...Array.from({ length: 11 }, (_, i) => `${i + 1}. Item ${i + 1}`)].join('\n');
  const r = await renderPdf({ title: 'Lists', markdown: md });
  const markers = r.boxes.filter((b) => b.kind === 'list-marker');
  const [l1, l2, l3] = markers;
  assert.deepEqual([l1.text, l2.text, l3.text], ['•', '–', '◦'], 'a bullet per level');
  assert.ok(l1.textX < l2.textX && l2.textX < l3.textX, 'each level indents');
  for (const m of markers) {
    assert.ok(m.x + m.w <= m.textX - 4 + 0.01, `marker ${m.text} ends before its text`);
    assert.ok(m.x >= r.margins.left - 0.01, 'never left of the margin');
  }
  const nine = markers.find((m) => m.text === '9.');
  const ten = markers.find((m) => m.text === '10.');
  assert.ok(Math.abs((nine.x + nine.w) - (ten.x + ten.w)) < 0.01, 'numbers are right-aligned');
  // The wrapped second line of level one starts under its text, not its marker.
  const wrapped = r.boxes.filter((b) => b.kind === 'text' && Math.abs(b.x - l1.textX) < 0.01);
  assert.ok(wrapped.length >= 2, 'both lines of the first item start at the text column');
});
