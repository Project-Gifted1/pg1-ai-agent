/**
 * P2: PDF creation (lib/pdf/*, the /pdf commands in api/chat.mjs,
 * /film storyboard, pg1_documents).
 *
 * Covered: the file is a valid PDF that pdf-lib and pdf.js both open; the
 * text comes back out (headings, lists, table cells, code, inline styles);
 * the page count and "Page n of N" footer; every font is embedded (no
 * standard font); no table cell or line runs past its column or the
 * margins; the page limit cuts with a note; the size guard; images; the
 * markdown parser; through the chat: /pdf this with a reply's text, "make
 * this a PDF" from history, /pdf <request> with a model call, /pdf list,
 * guests refused; storage (upload, row, signed link); the storyboard PDF;
 * the retention purge; the migration.
 *
 * Run with: node --test tests/pdf.test.mjs
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { PDFDocument, PDFName, PDFDict } from 'pdf-lib';
import { PGlite } from '@electric-sql/pglite';

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const { renderPdf, PdfTooLargeError, pdfMaxPages, DEFAULT_PDF_MAX_PAGES } = await import('../lib/pdf/render.mjs');
const { markdownToBlocks, inlineRuns } = await import('../lib/pdf/markdown.mjs');
const { makeDocument, purgeExpiredDocuments, documentRetentionDays } = await import('../lib/pdf/store.mjs');
const { parsePdfCommand, isPdfRequest, storyboardBlocks, titleFromMarkdown, handlePdfCommand } = await import('../lib/pdf/chat.mjs');
const { default: chatHandler, __clearAuthRateLimitState } = await import('../api/chat.mjs');

async function open(bytes) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, isEvalSupported: false, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    pages.push(tc.items.map((it) => it.str).join('').replace(/\s+/g, ' '));
  }
  return { numPages: doc.numPages, pages, all: pages.join(' ') };
}

const REPORT = `# Threat summary

Some **bold**, *italic* and \`inline code\` text with a [link](https://example.com/report).

## Findings
- Wallet flagged on the sanctions list
- Domain registered three days ago
1. Block the wallet
2. Watch the domain

| Indicator | Status | Reason |
|---|---|---|
| 0x7067312d00000000000000000000000000000001 | flagged | SANCTIONS_MATCH: the address is on the OFAC SDN list and this explanation is long enough to wrap onto several lines inside its column |
| pg1-test-flagged.invalid | flagged | DOMAIN_NEW |

\`\`\`bash
curl -s https://pg1-ai-agent.vercel.app/api/mcp -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' ${'x'.repeat(160)}
\`\`\`

> Not legal advice.
`;

// A 2x2 RGB PNG built at runtime (base64), so no long encoded blob sits in
// the source for secret scanners to mistake for a credential.
function tinyPng() {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2; // 2x2, 8-bit RGB
  const rows = Buffer.from([0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 255, 255, 255]); // filter byte + 2 pixels per row
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

// --- the renderer ---------------------------------------------------------------

test('a valid PDF that pdf-lib and pdf.js open, with the text extractable and the PG1 header and footer', async () => {
  const r = await renderPdf({ title: 'PG1 threat brief', subtitle: 'For the operator', markdown: REPORT }, { now: new Date('2026-10-14T10:00:00Z') });
  const bytes = Buffer.from(r.bytes);
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.match(bytes.subarray(-8).toString(), /%%EOF/);
  const lib = await PDFDocument.load(r.bytes, { updateMetadata: false });
  assert.equal(lib.getPageCount(), r.pages);
  assert.equal(lib.getProducer(), 'PG1');
  assert.equal(lib.getCreator(), 'PG1');
  assert.equal(lib.getTitle(), 'PG1 threat brief');
  const out = await open(r.bytes);
  assert.equal(out.numPages, r.pages);
  for (const s of ['PG1 threat brief', 'For the operator', 'Threat summary', 'Findings', 'Wallet flagged on the sanctions list', '1.', 'Block the wallet',
    'Indicator', 'SANCTIONS_MATCH', 'pg1-test-flagged.invalid', 'curl -s', 'Not legal advice.', 'bold', 'inline code', 'link (https://example.com/report)', 'Made with PG1 · 2026-10-14']) {
    assert.ok(out.all.includes(s), `extracted text has "${s}"`);
  }
  out.pages.forEach((p, i) => {
    assert.ok(p.includes(`Page ${i + 1} of ${r.pages}`), `page ${i + 1} footer`);
    assert.ok(p.startsWith('PG1'), `page ${i + 1} header`);
  });
  assert.doesNotMatch(out.all, /pdf-lib/i);
});

test('every font is embedded (TrueType subsets with FontFile2); no standard font is referenced', async () => {
  const r = await renderPdf({ title: 'Fonts', markdown: REPORT });
  const doc = await PDFDocument.load(r.bytes);
  const fonts = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.get(PDFName.of('Type')) === PDFName.of('Font')) fonts.push(obj);
  }
  const type0 = fonts.filter((f) => f.get(PDFName.of('Subtype')) === PDFName.of('Type0'));
  assert.equal(type0.length, 4, 'regular, bold, italic and mono');
  assert.ok(!fonts.some((f) => f.get(PDFName.of('Subtype')) === PDFName.of('Type1')), 'no standard Type1 font');
  for (const f of type0) {
    const desc = doc.context.lookup(f.get(PDFName.of('DescendantFonts'))).get(0);
    const cid = doc.context.lookup(desc);
    const fd = doc.context.lookup(cid.get(PDFName.of('FontDescriptor')));
    assert.ok(fd.get(PDFName.of('FontFile2')), 'the font program is in the file');
    assert.match(String(f.get(PDFName.of('BaseFont'))), /Liberation/);
  }
  const lic = readFileSync(new URL('../lib/pdf/fonts/LICENSE-Liberation.txt', import.meta.url), 'utf8');
  assert.match(lic, /SIL Open Font License/);
  assert.match(lic, /can be bundled, embedded/);
});

test('no table cell, code line or text runs past its column or the margins', async () => {
  const wide = `| ${Array.from({ length: 7 }, (_, i) => `Column ${i}`).join(' | ')} |\n|${'---|'.repeat(7)}\n` +
    Array.from({ length: 40 }, (_, r) => `| ${Array.from({ length: 7 }, (_, c) => (c === 3 ? 'averyveryveryverylongunbrokenidentifier'.repeat(3) : `cell ${r}.${c} with some words`)).join(' | ')} |`).join('\n');
  const r = await renderPdf({ title: 'Tables', markdown: `${REPORT}\n\n${wide}` });
  assert.ok(r.pages >= 2, 'the long table spans pages');
  const cells = r.boxes.filter((b) => b.kind === 'table-cell');
  assert.ok(cells.length > 200);
  for (const b of cells) {
    assert.ok(b.x >= b.cellX - 0.01 && b.x + b.w <= b.cellX + b.cellW + 0.01, `cell text "${b.text}" fits its column`);
  }
  for (const b of r.boxes) {
    assert.ok(b.x >= r.margins.left - 0.01, `"${b.text}" starts inside the left margin`);
    assert.ok(b.x + b.w <= r.margins.right + 0.01, `"${b.text}" ends inside the right margin (${b.x + b.w} > ${r.margins.right})`);
    assert.ok(b.y >= r.margins.bottom - 0.01, `"${b.text}" stays above the footer`);
  }
  // The header row is repeated on every page the table reaches.
  const headerPages = new Set(cells.filter((b) => b.text === 'Column' ).map((b) => b.page));
  assert.ok(headerPages.size >= 2);
});

test('the page limit: content past PG1_PDF_MAX_PAGES is cut and the last page says so', async () => {
  assert.equal(pdfMaxPages({}), DEFAULT_PDF_MAX_PAGES);
  assert.equal(DEFAULT_PDF_MAX_PAGES, 50);
  assert.equal(pdfMaxPages({ PG1_PDF_MAX_PAGES: '3' }), 3);
  assert.equal(pdfMaxPages({ PG1_PDF_MAX_PAGES: 'many' }), 50);
  const long = Array.from({ length: 400 }, (_, i) => `Paragraph ${i}. ${'Lorem ipsum dolor sit amet. '.repeat(6)}`).join('\n\n');
  const r = await renderPdf({ title: 'Long', markdown: long }, { maxPages: 3 });
  assert.equal(r.pages, 3);
  assert.equal(r.truncated, true);
  const out = await open(r.bytes);
  assert.match(out.pages[2], /Truncated: this document reached the 3-page limit/);
  assert.match(out.pages[2], /Page 3 of 3/);
});

test('the size guard: over the storage limit is an error, never a stored file', async () => {
  await assert.rejects(renderPdf({ title: 'Big', markdown: REPORT }, { maxBytes: 1000 }), (e) => e instanceof PdfTooLargeError && e.code === 'pdf_too_large');
  const calls = [];
  const made = await makeDocument({ doc: { title: 'Big', markdown: REPORT }, env: { PG1_STORAGE_MAX_MB: '0.001' }, supUrl: 'https://supabase.test', supKey: 'k', fetchImpl: async (u) => { calls.push(u); return new Response('{}'); } });
  assert.equal(made.ok, false);
  assert.equal(made.code, 'pdf_too_large');
  assert.equal(calls.length, 0, 'nothing uploaded');
});

test('images are embedded and scaled; characters the fonts lack print as "?"', async () => {
  // A 2x2 PNG.
  const png = tinyPng();
  const r = await renderPdf({ title: 'Img', blocks: [{ type: 'image', data: png, mime: 'image/png', caption: 'A test image' }, { type: 'paragraph', text: 'emoji 😀 here' }, { type: 'image', data: Buffer.from('not an image').toString('base64'), mime: 'image/png' }] });
  assert.ok(r.boxes.some((b) => b.kind === 'image'));
  const out = await open(r.bytes);
  assert.ok(out.all.includes('A test image'));
  assert.ok(out.all.includes('emoji ? here'));
  assert.ok(out.all.includes('[image could not be read]'));
});

test('markdown: headings, lists, tables, code, quotes, rules, page breaks; inline runs', () => {
  const blocks = markdownToBlocks('# T\n\npara one\nstill one\n\n- a\n- b\n\n3. c\n4. d\n\n| x | y |\n|---|---|\n| 1 | 2 \\| 3 |\n\n```js\nlet a\n```\n\n> q\n\n---\n\n\\pagebreak');
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'paragraph', 'list', 'list', 'table', 'code', 'quote', 'rule', 'pagebreak']);
  assert.equal(blocks[1].text, 'para one still one');
  assert.equal(blocks[3].start, 3);
  assert.deepEqual(blocks[4].rows, [['1', '2 | 3']]);
  assert.equal(blocks[5].lang, 'js');
  assert.deepEqual(inlineRuns('a **b** *c* `d` [e](https://f.test)'), [{ text: 'a ' }, { text: 'b', bold: true }, { text: ' ' }, { text: 'c', italic: true }, { text: ' ' }, { text: 'd', code: true }, { text: ' e (https://f.test)' }]);
  assert.equal(titleFromMarkdown('intro\n## **Q4** report\n# later'), 'Q4 report');
});

test('commands: /pdf, /pdf this, "make this a PDF", /pdf thread, /pdf usage, /pdf list, /pdf <request>', () => {
  assert.deepEqual(parsePdfCommand('/pdf'), { kind: 'help', rest: '' });
  assert.deepEqual(parsePdfCommand('/pdf this'), { kind: 'reply', rest: '' });
  assert.deepEqual(parsePdfCommand('/pdf thread'), { kind: 'thread', rest: '' });
  assert.deepEqual(parsePdfCommand('/pdf usage 30d'), { kind: 'usage', rest: '30d' });
  assert.deepEqual(parsePdfCommand('/pdf list'), { kind: 'list', rest: '' });
  assert.deepEqual(parsePdfCommand('/pdf a brief on EIP-7702'), { kind: 'write', rest: 'a brief on EIP-7702' });
  for (const t of ['make this a PDF', 'Make that into a pdf.', 'save it as a PDF', 'can you turn the last reply into a PDF?', 'export this as pdf']) {
    assert.ok(isPdfRequest(t), t);
    assert.equal(parsePdfCommand(t).kind, 'reply', t);
  }
  for (const t of ['what is a PDF?', 'make this a table', 'the pdf I sent you']) assert.equal(isPdfRequest(t), false, t);
});

test('the storyboard PDF: one shot table per scene, every shot listed', async () => {
  const timeline = {
    title: 'PG1 Launch', logline: 'An agent checks before it pays.', tier: 'standard', style: { look: 'cinematic', grade: 'cool' },
    characters: [{ id: 'c1', name: 'Ada', description: 'an analyst' }],
    scenes: [
      { title: 'Open', music: { mood: 'tense', bpm: 90 }, shots: [{ id: 'a', duration_s: 5, camera: 'push_in', description: 'A dark server room', voiceover: 'Every payment is a risk.' }, { id: 'b', duration_s: 4, camera: 'static', description: 'A wallet address on screen' }] },
      { title: 'Close', music: { mood: 'calm', bpm: 80 }, shots: [{ id: 'c', duration_s: 4, description: 'Logo', asset: { attachment: 1, mode: 'hold' } }] }
    ],
    end_card: { text: 'PG1', duration_s: 3 }
  };
  const blocks = storyboardBlocks(timeline, { shortId: '1a2b3c4d' });
  const tables = blocks.filter((b) => b.type === 'table');
  assert.equal(tables.length, 2);
  assert.deepEqual(tables[0].rows[0], ['1.1', '5 s', 'push_in', 'A dark server room', 'Every payment is a risk.']);
  assert.match(tables[1].rows[0][3], /^Your image 1/);
  const r = await renderPdf({ title: 'PG1 Launch: storyboard', blocks });
  const out = await open(r.bytes);
  for (const s of ['Scene 1: Open', 'Scene 2: Close', 'A dark server room', 'Every payment is a risk.', 'End card:', 'film 1a2b3c4d']) assert.ok(out.all.includes(s), s);
});

// --- storage --------------------------------------------------------------------

function storageStub() {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, method: options.method || 'GET', body: options.body });
    if (u.includes('/storage/v1/object/sign/')) return Response.json({ signedURL: '/object/sign/pg1-vault/documents/x.pdf?token=t' });
    if (u.includes('/storage/v1/object/')) return Response.json({ Key: 'ok' });
    if (u.includes('/rest/v1/pg1_documents')) {
      if ((options.method || 'GET') === 'POST') return new Response(JSON.stringify([JSON.parse(options.body)]), { status: 201 });
      return Response.json([{ id: '11111111-2222-3333-4444-555555555555', title: 'Old brief', pages: 2, bytes: 9000, source: 'chat', created_at: '2026-10-01T00:00:00Z', storage_path: 'documents/x.pdf' }]);
    }
    throw new Error('Unexpected network call in test: ' + u);
  };
  return { calls, fetchImpl };
}

test('makeDocument uploads the file, records the row with an expiry and returns a signed download card', async () => {
  const { calls, fetchImpl } = storageStub();
  const made = await makeDocument({ doc: { title: 'Q4 report', markdown: REPORT }, source: 'chat', env: {}, supUrl: 'https://supabase.test', supKey: 'k', fetchImpl, requestId: 'req1', now: new Date('2026-10-14T00:00:00Z') });
  assert.equal(made.ok, true);
  assert.equal(made.card.stored, true);
  assert.equal(made.card.title, 'Q4 report');
  assert.ok(made.card.pages >= 1);
  assert.match(made.card.url, /^https:\/\/supabase\.test\/storage\/v1\/object\/sign\/pg1-vault\/documents\/x\.pdf\?token=t&download=q4-report\.pdf$/);
  const upload = calls.find((c) => c.method === 'POST' && /\/storage\/v1\/object\/pg1-vault\/documents\/[0-9a-f-]{36}\.pdf$/.test(c.url));
  assert.ok(upload, 'uploaded under documents/<id>.pdf');
  const row = JSON.parse(calls.find((c) => c.url.endsWith('/rest/v1/pg1_documents')).body);
  assert.equal(row.expires_at, '2027-01-12T00:00:00.000Z', '90 days by default');
  assert.equal(row.source, 'chat');
  assert.ok(!('caller' in row) && !('ip' in row));
  assert.equal(documentRetentionDays({ PG1_PDF_RETENTION_DAYS: '7' }), 7);
});

test('the daily purge deletes expired files, then their rows', async () => {
  const calls = [];
  const res = await purgeExpiredDocuments({
    supUrl: 'https://supabase.test', supKey: 'k', now: Date.parse('2026-10-14T00:00:00Z'),
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || 'GET', body: options.body });
      if ((options.method || 'GET') === 'GET') return Response.json([{ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', storage_path: 'documents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.pdf' }]);
      return new Response(null, { status: 200 });
    }
  });
  assert.deepEqual(res, { ok: true, deleted: 1 });
  assert.match(calls[0].url, /expires_at=lt\.2026-10-14/);
  assert.equal(calls[1].method, 'DELETE');
  assert.deepEqual(JSON.parse(calls[1].body), { prefixes: ['documents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.pdf'] });
  assert.match(calls[2].url, /pg1_documents\?id=in\.\(aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\)/);
});

test('the migration: table, checks, RLS on, nothing for anon/authenticated, re-runnable', async () => {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  const sql = readFileSync(new URL('../supabase/migrations/20261018120000_pg1_documents.sql', import.meta.url), 'utf8');
  await db.exec(sql);
  await db.exec(sql);
  const { rows } = await db.query(`select relrowsecurity from pg_class where relname = 'pg1_documents'`);
  assert.equal(rows[0].relrowsecurity, true);
  const { rows: grants } = await db.query(`select grantee from information_schema.role_table_grants where table_name = 'pg1_documents' and grantee in ('anon', 'authenticated', 'PUBLIC')`);
  assert.deepEqual(grants, []);
  await assert.rejects(db.query(`insert into public.pg1_documents (title, pages, bytes, source, storage_path) values ('x', 1, 10, 'evil', 'documents/x.pdf')`), /pg1_documents_source_check/);
  await assert.rejects(db.query(`insert into public.pg1_documents (title, pages, bytes, storage_path) values ('x', 1, 10, '../etc')`), /pg1_documents_path_check/);
  await db.query(`insert into public.pg1_documents (title, pages, bytes, storage_path) values ('x', 1, 10, 'documents/x.pdf')`);
  assert.doesNotMatch(sql, /\b(?:drop table|delete from|truncate)\b/i);
});

// --- through the chat --------------------------------------------------------------

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const OPERATOR = { user: 'test-operator', pass: 'test-secret-pass' };
let ip = 0;
beforeEach(() => {
  process.env.USER_API_KEY = OPERATOR.user;
  process.env.USER_API_PASS = OPERATOR.pass;
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-pdf-test';
  for (const k of ['USER_API_USER', 'USER_API_PASSS', 'GEMINI_API_KEY', 'GEMINI_API_KEY1', 'GEMINI_API_KEY2', 'GEMINI_API_KEY_FREE', 'GEMINI_API_KEY_PAID', 'ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'PG1_STORAGE_MAX_MB']) delete process.env[k];
  __clearAuthRateLimitState();
});
after(() => { process.env = { ...ORIGINAL_ENV }; globalThis.fetch = ORIGINAL_FETCH; });

function makeRes() {
  return { statusCode: null, headers: {}, jsonBody: null, chunks: [], setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, status(c) { this.statusCode = c; return this; }, json(b) { this.jsonBody = b; return this; }, write(c) { this.chunks.push(String(c)); return true; }, end() { return this; }, on() {} };
}
async function chat(body, creds = OPERATOR) {
  const res = makeRes();
  await chatHandler({ method: 'POST', url: '/api/chat', headers: {}, socket: { remoteAddress: `10.81.0.${++ip % 250}` }, body: { ...creds, ...body } }, res);
  return res;
}
// The chat's own Supabase reads (messages, vault list, errors) answer empty.
function chatStorage(extra = null) {
  const s = storageStub();
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (extra) { const r = await extra(u, options); if (r) return r; }
    if (u.includes('/rest/v1/messages') || u.includes('/rest/v1/pg1_errors') || u.includes('/storage/v1/object/list/') || u.includes('/rest/v1/pg1_ai_usage')) return Response.json([]);
    return s.fetchImpl(url, options);
  };
  return s;
}

test('chat: the Save as PDF icon (/pdf this + pdfSource) makes that reply a PDF with a card', async () => {
  const s = chatStorage();
  const res = await chat({ prompt: '/pdf this', pdfSource: '## Wallet check\n\nThe wallet is **flagged**.\n\n| a | b |\n|---|---|\n| 1 | 2 |' });
  assert.equal(res.statusCode, 200);
  const { pdf, reply } = res.jsonBody;
  assert.equal(pdf.title, 'Wallet check');
  assert.equal(pdf.pages, 1);
  assert.match(pdf.url, /^https:\/\/supabase\.test\//);
  assert.match(reply, /^PDF ready: \*\*Wallet check\*\* · 1 page · \d+ KB\. Saved to the media library/);
  assert.ok(s.calls.some((c) => /\/storage\/v1\/object\/pg1-vault\/documents\//.test(c.url)));
  assert.ok(res.jsonBody.cards.some((c) => /^\[card\] PDF [0-9a-f-]+ "Wallet check": 1 page$/.test(c)), 'the card line goes into the thread history');
  assert.equal(res.jsonBody.taskState.objects[0].kind, 'pdf');
});

test('chat: "make this a PDF" uses the last reply in the thread; guests are refused', async () => {
  chatStorage();
  const history = [{ role: 'user', text: 'summarise' }, { role: 'model', text: '# Summary\n\nThree findings.' }, { role: 'user', text: 'make this a PDF' }];
  const res = await chat({ prompt: 'make this a PDF', history });
  assert.equal(res.jsonBody.pdf.title, 'Summary');
  const guest = await chat({ prompt: '/pdf this' }, { user: '', pass: '' });
  assert.equal(guest.statusCode, 401);
  const phrase = await chat({ prompt: 'make this a PDF' }, { user: '', pass: '' });
  assert.equal(phrase.statusCode, 401);
});

test('chat: /pdf <request> writes the document with one model call and lays it out', async () => {
  process.env.GEMINI_API_KEY_PAID = ['AI', 'za', 'PaidKeyForPdfTests'.padEnd(36, '0')].join(''); // fake, built at runtime
  const seen = [];
  chatStorage(async (u, options) => {
    if (!u.includes('generativelanguage.googleapis.com')) return null;
    const body = JSON.parse(options.body);
    seen.push(((body.systemInstruction || {}).parts || []).map((p) => p.text).join(''));
    return Response.json({ candidates: [{ content: { parts: [{ text: '# EIP-7702 brief\n\n## Risk\n- Delegated wallets can run code.\n\n| Field | Meaning |\n|---|---|\n| delegated | true when delegated |' }] } }] });
  });
  const res = await chat({ prompt: '/pdf a one-page brief on EIP-7702 delegation' });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^You write documents that PG1 turns into a PDF/);
  assert.equal(res.jsonBody.pdf.title, 'EIP-7702 brief');
});

test('chat: /pdf list shows the documents shelf; /pdf alone is the help', async () => {
  chatStorage();
  const list = await chat({ prompt: '/pdf list' });
  assert.match(list.jsonBody.reply, /### \[ DOCUMENTS \]\n- 11111111 · Old brief · 2 pages · 2026-10-01 · chat/);
  const help = await chat({ prompt: '/pdf' });
  assert.match(help.jsonBody.reply, /^### \[ PDF \]/);
});

test('handlePdfCommand refuses anyone but the operator and never throws', async () => {
  assert.match((await handlePdfCommand({ text: '/pdf this', isOperator: false })).reply, /operator only/);
  const r = await handlePdfCommand({ text: '/pdf write something', isOperator: true, writeDocument: async () => { throw new Error('boom'); } });
  assert.match(r.reply, /could not make that PDF/);
});
