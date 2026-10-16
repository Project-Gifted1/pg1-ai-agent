/**
 * What PG1 puts in front of a client: items 2-9 of the Studio + Sound
 * brief, checked against the operator's definitions:
 *
 *   2  anything the safety filters refuse is never offered (voice cloning)
 *   3  never promise exclusive rights, a buyout or copyright ownership; say
 *      "full commercial use rights, subject to provider terms"
 *   4  grounding-redirect URLs resolve to the real article URL, or the
 *      source is shown as publication and title without a link
 *   5  figures not in a cited source are labelled PG1's estimate; PG1's own
 *      price maths is never shown as an industry benchmark
 *   6  tier names and package structure are tracked across the thread;
 *      changes must be explained
 *   7  no "Agreement"/"Contract" titles unless the operator asks; proposals
 *      are titled by the offer
 *   8  private details from the operator's messages ("my sister") never
 *      appear in client documents
 *   9  PDF bullets at the start of each item, wrapped lines included;
 *      nested lists keep their indentation
 *
 * Item 10 (white label) is tests/white-label.test.mjs.
 *
 * Run with: node --test tests/client-docs.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSources, isGroundingRedirect, stripRedirectLinks, clientTitle, clientHeadings, hasAgreementTitle, asksForAgreement, offerName, isClientDocument, scrubPrivateContext, personalContext, prepareClientDocument } from '../lib/clientDocs.mjs';
import { sourcesNote, unsourcedMarketFigures, UNSOURCED_NOTE, OWN_ESTIMATE_NOTE, ownMathAsBenchmark, tierChanges, tierChangeNote, packageStructure, mergeFigures, SOURCED_FIGURES_DIRECTIVE } from '../lib/replyFacts.mjs';
import { updateFromReply, emptyTaskState, renderTaskState, cleanTaskState } from '../lib/taskState.mjs';
import { RIGHTS_WORDING, SAFETY_WORDING, offerViolations, offerability, offersDirective } from '../lib/capabilities/offers.mjs';
import { capability } from '../lib/capabilities/registry.mjs';
import { ownPriceAmounts } from '../lib/capabilities/costs.mjs';
import { markdownToBlocks } from '../lib/pdf/markdown.mjs';
import { renderPdf } from '../lib/pdf/render.mjs';
import { handlePdfCommand, PDF_WRITE_SYSTEM } from '../lib/pdf/chat.mjs';

import { pdfText } from './helpers/pdfText.mjs';

function storage() {
  const uploads = [];
  const fetchImpl = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('/storage/v1/object/sign/')) return Response.json({ signedURL: '/object/sign/pg1-vault/documents/x.pdf?token=t' });
    if (u.includes('/storage/v1/object/')) { uploads.push(options.body); return Response.json({ Key: 'ok' }); }
    if (u.includes('/rest/v1/pg1_documents')) return new Response(JSON.stringify([JSON.parse(options.body)]), { status: 201 });
    throw new Error('Unexpected network call in test: ' + u);
  };
  return { uploads, fetchImpl };
}

// --- item 2 -----------------------------------------------------------------------

test('item 2: what the safety filters refuse is never offered, voice cloning included', () => {
  assert.equal(offerability(capability('voice_cloning')), 'never');
  assert.equal(offerability(capability('voice_cloning'), { shipped: [1, 4] }), 'never', 'even with Phase 4 listed, while PG1 Sound refuses it');
  assert.deepEqual(offerViolations('Every package includes voice cloning.').map((v) => v.id), ['voice_cloning']);
  for (const [t, id] of [['Covers of any existing song.', 'refused_covers'], ['Vocals in the voice of any famous artist.', 'refused_voice_style'], ['Celebrity likeness for your ad.', 'refused_likeness'], ['Marvel characters in your trailer.', 'refused_characters'], ['Explicit content on request.', 'refused_adult']]) {
    assert.deepEqual(offerViolations(t).map((v) => v.id), [id], t);
  }
  assert.deepEqual(offerViolations('PG1 does not make covers of existing songs.'), []);
  assert.match(offersDirective(), /Never offer what PG1's safety filters refuse/);
  assert.match(SAFETY_WORDING, /PG1's own content checks and the generation providers' safety filters/);
  assert.match(PDF_WRITE_SYSTEM, /Never offer what PG1's safety filters refuse/);
});

// --- item 3 -----------------------------------------------------------------------

test('item 3: no exclusive rights, buyout or copyright ownership; the wording is "full commercial use rights, subject to provider terms"', () => {
  assert.match(RIGHTS_WORDING, /^Full commercial use rights, subject to provider terms\./);
  assert.deepEqual(offerViolations(RIGHTS_WORDING), []);
  for (const [t, id] of [['Exclusive rights to every film.', 'exclusive_rights'], ['A full buyout of the music is included.', 'exclusive_rights'], ['You will own the copyright.', 'ownership_promise'], ['The client receives full copyright and complete ownership.', 'ownership_promise'], ['Copyright ownership transfers on payment.', 'ownership_promise']]) {
    assert.deepEqual(offerViolations(t).map((v) => v.id), [id], t);
  }
  assert.match(PDF_WRITE_SYSTEM, /Full commercial use rights, subject to provider terms/);
});

// --- item 4 -----------------------------------------------------------------------

const REDIRECT = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbCdEf123';

test('item 4: a grounding redirect resolves to the real article URL (one HEAD, never followed blindly)', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts.method, redirect: opts.redirect });
    if (url === REDIRECT) return new Response(null, { status: 302, headers: { location: 'https://www.example.org/video-rates?ref=1' } });
    return new Response(null, { status: 404 });
  };
  const out = await resolveSources([{ url: REDIRECT, title: 'example.org' }, { url: 'https://direct.example/page', title: 'Direct page' }], { fetchImpl });
  assert.deepEqual(out, [{ title: 'example.org', url: 'https://www.example.org/video-rates?ref=1', publication: 'example.org' }, { title: 'Direct page', url: 'https://direct.example/page', publication: 'direct.example' }]);
  assert.deepEqual(calls, [{ url: REDIRECT, method: 'HEAD', redirect: 'manual' }]);
  assert.equal(isGroundingRedirect(REDIRECT), true);
  assert.match(sourcesNote({ text: 'Creator: $45/month', sources: out }), /1\. \[example\.org\]\(https:\/\/www\.example\.org\/video-rates\?ref=1\)\n2\. \[Direct page\]\(https:\/\/direct\.example\/page\) \(direct\.example\)/);
});

test('item 4: an unresolvable redirect is shown as publication and title without a link, never as the redirect', async () => {
  const cases = [
    async () => { throw new Error('network'); },
    async () => new Response(null, { status: 500 }),
    async () => new Response(null, { status: 302, headers: { location: 'http://insecure.example/' } }),
    async () => new Response(null, { status: 302, headers: { location: REDIRECT } }),
    async () => new Response(null, { status: 302, headers: { location: 'https://www.google.com/url?q=x' } }),
    (url, opts) => new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))))
  ];
  for (const fetchImpl of cases) {
    const out = await resolveSources([{ url: REDIRECT, title: 'reuters.com' }], { fetchImpl, timeoutMs: 50 });
    assert.deepEqual(out, [{ title: 'reuters.com', url: null, publication: 'reuters.com' }]);
    const note = sourcesNote({ text: 'Creator: $45/month', sources: out });
    assert.match(note, /1\. reuters\.com \(no direct link\)/);
    assert.doesNotMatch(note, /vertexaisearch|https?:/);
  }
  assert.match(sourcesNote({ text: 'Creator: $45', sources: [{ title: 'Video rates 2026', publication: 'example.org', url: null }] }), /1\. Video rates 2026, example\.org \(no direct link\)/);
  assert.equal(stripRedirectLinks(`See [rates](${REDIRECT}) and ${REDIRECT} here`), 'See rates and  here');
  assert.match(SOURCED_FIGURES_DIRECTIVE, /never a redirect or search-results link/);
});

test('item 4: through the chat, sources show the real URL, or the title without a link; never the redirect', async () => {
  const { default: chatHandler, __clearAuthRateLimitState } = await import('../api/chat.mjs');
  const saved = { ...process.env };
  const savedFetch = globalThis.fetch;
  try {
    Object.assign(process.env, { USER_API_KEY: 'test-operator', USER_API_PASS: 'test-secret-pass', GEMINI_API_KEY: 'stub-gemini-key' });
    for (const k of ['ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'CARTESIA_API_KEY']) delete process.env[k];
    __clearAuthRateLimitState();
    const DEAD = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/Dead999';
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u === REDIRECT) return new Response(null, { status: 302, headers: { location: 'https://rates.example/video' } });
      if (u === DEAD) throw new Error('unreachable');
      if (!u.includes('generativelanguage.googleapis.com')) throw new Error('Unexpected network call in test: ' + u);
      return Response.json({ candidates: [{ content: { parts: [{ text: '- Creator: $45/month\n- Studio: $80/month' }] }, finishReason: 'STOP', groundingMetadata: { groundingChunks: [{ web: { uri: REDIRECT, title: 'rates.example' } }, { web: { uri: DEAD, title: 'trade.example' } }] } }] });
    };
    const res = { statusCode: null, headers: {}, jsonBody: null, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, status(c) { this.statusCode = c; return this; }, json(b) { this.jsonBody = b; return this; }, write() { return true; }, end() { return this; }, on() {} };
    await chatHandler({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: '10.89.0.1' }, body: { user: 'test-operator', pass: 'test-secret-pass', prompt: 'what do video edits cost these days?' } }, res);
    assert.match(res.jsonBody.reply, /1\. \[rates\.example\]\(https:\/\/rates\.example\/video\)\n2\. trade\.example \(no direct link\)/);
    assert.doesNotMatch(res.jsonBody.reply, /vertexaisearch/);
  } finally {
    process.env = saved;
    globalThis.fetch = savedFetch;
  }
});

// --- item 5 -----------------------------------------------------------------------

test('item 5: figures in no cited source are labelled PG1\'s estimate; market figures say so', () => {
  assert.equal(sourcesNote({ text: '- Creator: $45/month\n- Studio: $80/month', sources: [] }), OWN_ESTIMATE_NOTE);
  assert.match(OWN_ESTIMATE_NOTE, /PG1's own estimates, not figures from a cited source/);
  for (const t of ['Agencies typically charge $2,000 for a 60-second ad.', 'The industry average is $1,500 per minute.', 'Studies show 73% of buyers watch video first.']) {
    assert.equal(unsourcedMarketFigures(t), true, t);
    assert.equal(sourcesNote({ text: t, sources: [] }), UNSOURCED_NOTE, t);
  }
  assert.equal(sourcesNote({ text: 'No prices in this reply.', sources: [] }), '');
  assert.match(sourcesNote({ text: 'Creator: $45/month', sources: [{ url: 'https://a.example/x', title: 'a.example' }] }), /Figures not shown in these sources are PG1's own estimates\./);
});

test('item 5: PG1\'s own price maths is never presented as an industry benchmark', () => {
  const own = ownPriceAmounts([{ key: 'creator', label: 'Creator', value: '$45/month' }]);
  assert.ok(own.includes(19.44) && own.includes(45), 'package minimums and the thread\'s own prices');
  assert.deepEqual(ownMathAsBenchmark('A 1-minute film at $19.44 is the industry benchmark.', own), ['$19.44']);
  assert.deepEqual(ownMathAsBenchmark('Creator at $45/month is in line with the market rate.', own), ['$45']);
  assert.deepEqual(ownMathAsBenchmark('Creator: $45/month.', own), [], 'just stating PG1\'s price is fine');
  assert.deepEqual(ownMathAsBenchmark('The market rate is $2,000 (https://a.example/rates).', own), [], 'a cited market figure is not PG1\'s maths');
  assert.match(sourcesNote({ text: 'Our $19.44 film is the industry benchmark.', sources: [], ownAmounts: own }), /\*\*Note:\*\* \$19\.44 is PG1's own price calculation, not an industry benchmark\./);
});

// --- item 6 -----------------------------------------------------------------------

const FIRST = '## Packages\n| Tier | Price | Includes |\n|---|---|---|\n| Starter | $25/month | 4 clips |\n| Creator | $45/month | 8 clips |\n| Studio | $80/month | 16 clips |';

test('item 6: the thread\'s tier names and package table columns are tracked in the task state', () => {
  assert.deepEqual(packageStructure(FIRST), { tiers: ['Starter', 'Creator', 'Studio'], columns: ['Tier', 'Price', 'Includes'] });
  const s = updateFromReply(emptyTaskState(), { prompt: 'price it', reply: { reply: FIRST } });
  assert.deepEqual(s.columns, ['Tier', 'Price', 'Includes']);
  assert.match(renderTaskState(s), /Package table columns already used \(keep them, or say what changed\): Tier \| Price \| Includes/);
  assert.deepEqual(cleanTaskState(JSON.parse(JSON.stringify(s))).columns, ['Tier', 'Price', 'Includes'], 'it survives the round trip to the client');
});

test('item 6: renamed or dropped tiers and changed columns must be explained', () => {
  const prev = mergeFigures([], FIRST, 1);
  const cols = ['Tier', 'Price', 'Includes'];
  const swapped = tierChanges(prev, '## Packages\n| Tier | Price | Includes |\n|---|---|---|\n| Basic | $25/month | 4 clips |\n| Pro | $45/month | 8 clips |\n| Studio | $80/month | 16 clips |', { columns: cols });
  assert.deepEqual(swapped, { dropped: ['Starter', 'Creator'], added: ['Basic', 'Pro'], droppedColumns: [], addedColumns: [] });
  assert.equal(tierChangeNote(swapped), '**Package structure changed:** earlier in this thread the tiers were Starter, Creator; this reply uses Basic, Pro, without saying why. Keep one set of tier names and the same structure (what each tier includes, its price), or say what changed.');
  const restructured = tierChanges(prev, '## Packages\n| Tier | Price | Delivery |\n|---|---|---|\n| Starter | $25/month | 5 days |\n| Creator | $45/month | 3 days |\n| Studio | $80/month | 2 days |', { columns: cols });
  assert.deepEqual([restructured.droppedColumns, restructured.addedColumns], [['Includes'], ['Delivery']]);
  assert.match(tierChangeNote(restructured), /the package table drops Includes and adds Delivery/);
  const dropped = tierChanges(prev, '## Packages\n| Tier | Price | Includes |\n|---|---|---|\n| Starter | $25/month | 4 clips |\n| Creator | $45/month | 8 clips |', { columns: cols });
  assert.match(tierChangeNote(dropped), /this reply leaves out Studio, set out earlier in this thread/);
  assert.equal(tierChanges(prev, 'We renamed the tiers:\n| Tier | Price | Includes |\n|---|---|---|\n| Basic | $25/month | 4 clips |\n| Pro | $45/month | 8 clips |', { columns: cols }), null, 'explained');
  assert.equal(tierChanges(prev, 'Same tiers, plus an add-on:\n- Starter: $25/month\n- Creator: $45/month\n- Studio: $80/month\n- Rush delivery: $20'), null, 'an add-on is not a tier');
  assert.match(PDF_WRITE_SYSTEM, /same tier names and the same structure for every tier/);
});

// --- item 7 -----------------------------------------------------------------------

test('item 7: no Agreement or Contract titles unless the operator asks; a proposal is titled by the offer', () => {
  assert.equal(offerName('## Short-form video packages\n| Tier | Price |'), 'Short-form video packages');
  assert.equal(clientTitle('Service Agreement', { offer: 'Short-form video packages' }), 'Short-form video packages proposal');
  assert.equal(clientTitle('Video Production Contract'), 'Video Production Proposal');
  assert.equal(clientTitle('Statement of Work: Brand Film'), 'Brand Film proposal');
  assert.equal(clientTitle('Short-form video packages'), 'Short-form video packages');
  assert.equal(hasAgreementTitle('Agreement'), true);
  assert.equal(clientHeadings('# Licence Agreement\n\nText about the agreement.\n## Contract terms'), '# Licence Proposal\n\nText about the agreement.\n## Proposal terms');
  // The operator asked for one: their title stands.
  assert.equal(asksForAgreement('draft a service agreement for the client'), true);
  const asked = prepareClientDocument({ title: 'Service Agreement', markdown: '## Scope\nFour clips a month.', request: 'draft a service agreement for the client' });
  assert.equal(asked.title, 'Service Agreement');
  // A generic title becomes the offer's name.
  assert.equal(prepareClientDocument({ title: 'PG1 reply', markdown: '## Bakery video packages\n| Tier | Price |\n|---|---|\n| Starter | $45 |' }).title, 'Bakery video packages proposal');
  assert.match(PDF_WRITE_SYSTEM, /a proposal titled by the offer/);
  assert.match(PDF_WRITE_SYSTEM, /unless the operator asks for one/);
});

// --- item 8 -----------------------------------------------------------------------

test('item 8: private details from the operator\'s own messages never reach a client document', () => {
  const said = 'Make a package for my sister Anna, she runs a bakery. I\'m in debt so price it well.';
  assert.deepEqual(personalContext(said), { phrases: ['my sister', 'i\'m in debt'], names: ['Anna'] });
  const md = '## Bakery video packages\n| Tier | Price |\n|---|---|\n| Starter | $45/month |\n\n- Made for Anna\'s bakery\n- A family discount for your sister\n- Fair prices while you are in debt\n- Four clips a month';
  const out = scrubPrivateContext(md, { operatorText: said });
  assert.equal(out.markdown, '## Bakery video packages\n| Tier | Price |\n|---|---|\n| Starter | $45/month |\n\n- Four clips a month');
  assert.deepEqual(out.removed.map((r) => r.id), ['operator_personal', 'operator_personal', 'operator_personal']);
  // Nothing personal said: nothing personal removed.
  assert.equal(scrubPrivateContext('- A family-run bakery', { operatorText: 'price a bakery package' }).markdown, '- A family-run bakery');
  assert.match(PDF_WRITE_SYSTEM, /anything personal the operator said about themselves or people in their life, such as "my sister"/);
});

test('item 8: PG1\'s costs, settings, ids and operator notes stay out too', () => {
  const md = ['## What you get', '- Four 15-second clips a month', '- Our cost is about $3 a clip, a 1.5x margin', '- Set PG1_FILM_MAX_USD to raise the cap', '- Request ID: req_7h3k9q2m1x', '**Offer check:** something for the operator', '## Price', '| Tier | Price |', '|---|---|', '| Creator | $45/month |'].join('\n');
  const out = scrubPrivateContext(md);
  assert.equal(out.markdown, '## What you get\n- Four 15-second clips a month\n## Price\n| Tier | Price |\n|---|---|\n| Creator | $45/month |');
  assert.deepEqual(out.removed.map((r) => r.id), ['internal_costs', 'config_names', 'internal_ids', 'operator_notes']);
  assert.equal(isClientDocument({ request: 'make the package proposal for the client a PDF' }), true);
  assert.equal(isClientDocument({ request: 'a PDF of my internal cost breakdown for the packages' }), false);
});

test('/pdf for a client: titled by the offer, no private or personal context, nothing PG1 may not offer; changes go to the operator only', async () => {
  const { uploads, fetchImpl } = storage();
  const history = [{ role: 'user', text: 'My sister Anna runs a bakery and needs video packages.' }, { role: 'model', text: 'Sure.' }];
  const written = '# Bakery Service Agreement\n\n## Bakery video packages\n| Tier | Price |\n|---|---|\n| Creator | $45/month |\n| Studio | $80/month |\n\n- Anna gets a family discount\n- Our cost is $3 a clip\n- Exclusive rights to every film\n- 4K delivery: custom, on request';
  const r = await handlePdfCommand({ text: '/pdf the package proposal for the client', history, isOperator: true, supUrl: 'https://supabase.test', supKey: 'k', fetchImpl, writeDocument: async () => ({ markdown: written }), now: new Date('2026-10-14T00:00:00Z') });
  assert.equal(r.pdf.title, 'Bakery video packages proposal');
  const { title, text } = await pdfText(uploads[0]);
  assert.equal(title, 'Bakery video packages proposal');
  assert.match(text, /Prepared by Project-Gifted1™ · 2026-10-14/);
  assert.match(text, /Creator \$45\/month/);
  for (const banned of [/Agreement/, /Anna/, /sister/i, /our cost/i, /Exclusive/i, /PG1 chat/]) assert.doesNotMatch(text, banned);
  assert.match(r.reply, /Titled "Bakery video packages proposal" rather than "Bakery Service Agreement"/);
  assert.match(r.reply, /personal detail from the operator's message/);
  assert.match(r.reply, /exclusive rights \(PG1 never offers it\)/);
  // An operator's own document is left as written.
  uploads.length = 0;
  const own = await handlePdfCommand({ text: '/pdf my internal cost breakdown', isOperator: true, supUrl: 'https://supabase.test', supKey: 'k', fetchImpl, writeDocument: async () => ({ markdown: '# Cost breakdown\n\n- Replicate: $3 a clip' }) });
  assert.equal(own.pdf.title, 'Cost breakdown');
  assert.match((await pdfText(uploads[0])).text, /Replicate: \$3 a clip/);
});

// --- item 9 -----------------------------------------------------------------------

test('item 9: nested lists keep their level and numbering; wrapped source lines stay in their item', () => {
  const [list, second] = markdownToBlocks('- Creator\n  - 8 clips\n  - 1 revision\n    1. first\n    2. second\n- Studio\n  wrapped text\n\n  - nested after a blank line\n\n1. alone');
  assert.deepEqual(list.entries.map((e) => [e.text, e.level, e.ordered ? e.number : '-']), [
    ['Creator', 0, '-'], ['8 clips', 1, '-'], ['1 revision', 1, '-'], ['first', 2, 1], ['second', 2, 2], ['Studio wrapped text', 0, '-'], ['nested after a blank line', 1, '-']
  ]);
  assert.deepEqual([second.ordered, second.start, second.items], [true, 1, ['alone']]);
  const [b] = markdownToBlocks('• one\n  1. a\n  2. b\n• two\n  1. c');
  assert.deepEqual(b.entries.map((e) => e.ordered ? e.number : e.text), ['one', 1, 2, 'two', 1]);
});

test('item 9: each bullet sits at the start of its item\'s first line; wrapped lines hang under the text; levels indent', async () => {
  const long = 'Level one with a long line that wraps onto a second and a third line inside the page margins of the PDF so that the hanging indent of every wrapped line is exercised properly';
  const md = [`- ${long} ${long}`, `  - Level two ${long} ${long}`, '    - Level three', ...Array.from({ length: 11 }, (_, i) => `${i + 1}. Item ${i + 1}`)].join('\n');
  const r = await renderPdf({ title: 'Lists', markdown: md });
  const markers = r.boxes.filter((b) => b.kind === 'list-marker');
  const [l1, l2, l3] = markers;
  assert.deepEqual([l1.text, l2.text, l3.text], ['•', '–', '◦'], 'a bullet per level');
  assert.ok(l1.textX < l2.textX && l2.textX < l3.textX, 'each level indents');
  const texts = r.boxes.filter((b) => b.kind === 'text');
  for (const m of [l1, l2]) {
    const lines = texts.filter((b) => b.page === m.page && Math.abs(b.x - m.textX) < 0.01 && b.y <= m.y + 0.01);
    const first = lines.reduce((a, b) => (b.y > a.y ? b : a));
    assert.ok(Math.abs(first.y - m.y) < 0.01, `bullet ${m.text} is on its item's first line`);
    assert.ok(lines.length >= 3, `the wrapped lines of the ${m.text} item start at the text column, not under the bullet`);
    assert.ok(!texts.some((b) => b.page === m.page && b.y < m.y && b.y > m.y - 40 && b.x < m.textX - 0.01 && b.x > m.x - 1), 'nothing wraps back under the bullet');
  }
  for (const m of markers) {
    assert.ok(m.x + m.w <= m.textX - 4 + 0.01, `marker ${m.text} ends before its text`);
    assert.ok(m.x >= r.margins.left - 0.01, 'never left of the margin');
  }
  const nine = markers.find((m) => m.text === '9.');
  const ten = markers.find((m) => m.text === '10.');
  assert.ok(Math.abs((nine.x + nine.w) - (ten.x + ten.w)) < 0.01, 'numbers are right-aligned');
});
