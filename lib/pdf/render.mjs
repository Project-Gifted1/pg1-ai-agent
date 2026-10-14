// PG1 PDF renderer: pure JS (pdf-lib + fontkit), no headless browser.
//
// renderPdf({ title, subtitle, blocks | markdown }, options) lays out
// headings, paragraphs with **bold** / *italic* / `code` runs, bulleted and
// numbered lists, tables (column widths fitted to the page, long words
// broken, the header repeated on each page, never wider than the margins),
// code blocks (monospace, wrapped, shaded), quotes, rules, page breaks and
// PNG/JPEG images, with a PG1 header and a footer with "Page n of N" on
// every page.
//
// Fonts: Liberation Sans (regular, bold, italic) and Liberation Mono,
// vendored in lib/pdf/fonts under the SIL Open Font License 1.1, which
// allows embedding. They are embedded as subsets, so every PDF carries its
// own fonts and no standard (non-embedded) font is ever referenced. A
// character the fonts do not have is printed as "?".
//
// Limits: at most maxPages pages (PG1_PDF_MAX_PAGES, default 50): content
// past that is cut and the last page says so (result.truncated). The saved
// file must be at most maxBytes (PG1_STORAGE_MAX_MB), else PdfTooLargeError.
//
// White label: the document's producer and creator are "PG1".

import { readFileSync } from 'node:fs';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { markdownToBlocks, inlineRuns } from './markdown.mjs';

export const DEFAULT_PDF_MAX_PAGES = 50;
export const HARD_PDF_MAX_PAGES = 500;
export const PDF_BRAND = 'PG1';

export function pdfMaxPages(env = process.env) {
  const n = Number(env.PG1_PDF_MAX_PAGES);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, HARD_PDF_MAX_PAGES) : DEFAULT_PDF_MAX_PAGES;
}

export class PdfTooLargeError extends Error {
  constructor(bytes, maxBytes) {
    super(`The PDF is ${(bytes / 1048576).toFixed(1)} MB, over the ${(maxBytes / 1048576).toFixed(1)} MB storage limit.`);
    this.name = 'PdfTooLargeError';
    this.code = 'pdf_too_large';
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

// Literal URLs, so the deployment's file tracer bundles the fonts.
const FONT_URLS = {
  regular: new URL('./fonts/LiberationSans-Regular.ttf', import.meta.url),
  bold: new URL('./fonts/LiberationSans-Bold.ttf', import.meta.url),
  italic: new URL('./fonts/LiberationSans-Italic.ttf', import.meta.url),
  mono: new URL('./fonts/LiberationMono-Regular.ttf', import.meta.url)
};
const FONT_FILES = FONT_URLS;
let fontBytesCache = null;
export function fontBytes() {
  if (!fontBytesCache) fontBytesCache = Object.fromEntries(Object.entries(FONT_URLS).map(([k, u]) => [k, readFileSync(u)]));
  return fontBytesCache;
}

// A4, points.
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = { left: 56, right: 56, top: 78, bottom: 66 };
const CONTENT_W = PAGE_W - M.left - M.right;
const INK = rgb(0.067, 0.094, 0.153);
const MUTED = rgb(0.42, 0.45, 0.5);
const GOLD = rgb(0.79, 0.64, 0.17);
const RULE = rgb(0.85, 0.86, 0.88);
const SHADE = rgb(0.953, 0.957, 0.965);
const TABLE_HEAD = rgb(0.93, 0.94, 0.95);
const BODY = 10.5;
const LH = 1.4;
const HEADING_SIZES = [20, 16, 13.5, 12, 11, 11];
const CODE_SIZE = 8.5;
const CELL_PAD = 5;
const TABLE_SIZE = 9;

class StopLayout extends Error {}

export async function renderPdf(doc = {}, { maxPages = DEFAULT_PDF_MAX_PAGES, maxBytes = Infinity, now = new Date() } = {}) {
  // updateMetadata: false, so pdf-lib never stamps itself as the producer.
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.registerFontkit(fontkit);
  const bytes = fontBytes();
  const fonts = {};
  for (const k of Object.keys(FONT_FILES)) fonts[k] = await pdf.embedFont(bytes[k], { subset: true });
  const charsets = Object.fromEntries(Object.entries(fonts).map(([k, f]) => [k, new Set(f.getCharacterSet())]));

  const title = oneLine(doc.title || 'PG1 document', 140);
  pdf.setTitle(title);
  pdf.setAuthor(PDF_BRAND);
  pdf.setCreator(PDF_BRAND);
  pdf.setProducer(PDF_BRAND);
  pdf.setSubject(oneLine(doc.subtitle || '', 200));
  pdf.setCreationDate(now);
  pdf.setModificationDate(now);

  const boxes = []; // every drawn text and table cell, for the layout tests
  let page = null;
  let y = 0;
  let truncated = false;
  const pages = () => pdf.getPageCount();

  const clean = (text, font) => {
    const set = charsets[font];
    let out = '';
    for (const ch of String(text).replace(/\t/g, '    ').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')) {
      const cp = ch.codePointAt(0);
      out += cp === 10 || set.has(cp) ? ch : '?';
    }
    return out;
  };
  const width = (text, font, size) => fonts[font].widthOfTextAtSize(text, size);

  const newPage = () => {
    if (pages() >= maxPages) {
      truncated = true;
      throw new StopLayout();
    }
    page = pdf.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - M.top;
  };
  const ensure = (h) => {
    if (!page || y - h < M.bottom) newPage();
  };
  const drawText = (text, { x, size, font = 'regular', color = INK, kind = 'text' }) => {
    const t = clean(text, font);
    if (!t) return;
    page.drawText(t, { x, y, size, font: fonts[font], color });
    boxes.push({ page: pages(), x, y, w: width(t, font, size), size, kind, text: t });
  };

  // Wraps styled runs into lines of at most maxW. Words longer than a line
  // are broken by character, so nothing is ever wider than maxW.
  const wrapRuns = (runs, size, maxW, { baseFont = 'regular' } = {}) => {
    const fontOf = (r) => (r.code ? 'mono' : r.bold ? 'bold' : r.italic ? 'italic' : baseFont);
    const tokens = [];
    for (const r of runs) {
      const f = fontOf(r);
      const parts = clean(r.text, f).split(/(\s+)/);
      for (const p of parts) if (p) tokens.push({ text: p, font: f, space: /^\s+$/.test(p) });
    }
    const lines = [];
    let line = [];
    let lineW = 0;
    const push = () => { while (line.length && line[line.length - 1].space) { lineW -= line[line.length - 1].w; line.pop(); } lines.push(line); line = []; lineW = 0; };
    for (const tok of tokens) {
      if (tok.text.includes('\n')) { push(); continue; }
      const text = tok.space ? ' ' : tok.text;
      let w = width(text, tok.font, size);
      if (tok.space) {
        if (!line.length) continue;
        line.push({ ...tok, text, w });
        lineW += w;
        continue;
      }
      if (lineW + w <= maxW) { line.push({ ...tok, text, w }); lineW += w; continue; }
      if (line.length) push();
      if (w <= maxW) { line.push({ ...tok, text, w }); lineW = w; continue; }
      // Break a long word by character.
      let chunk = '';
      for (const ch of text) {
        if (width(chunk + ch, tok.font, size) > maxW && chunk) {
          line.push({ ...tok, text: chunk, w: width(chunk, tok.font, size) });
          push();
          chunk = '';
        }
        chunk += ch;
      }
      w = width(chunk, tok.font, size);
      line.push({ ...tok, text: chunk, w });
      lineW = w;
    }
    if (line.length) push();
    return lines.length ? lines : [[]];
  };

  const drawLines = (lines, { x, size, color = INK, kind = 'text' }) => {
    const lh = size * LH;
    for (const l of lines) {
      ensure(lh);
      y -= size;
      let cx = x;
      for (const seg of l) {
        if (!seg.space) drawText(seg.text, { x: cx, size, font: seg.font, color, kind });
        cx += seg.w;
      }
      y -= lh - size;
    }
  };

  const heading = (b) => {
    const level = Math.min(6, Math.max(1, Number(b.level) || 1));
    const size = HEADING_SIZES[level - 1];
    const lines = wrapRuns([{ text: b.text, bold: true }], size, CONTENT_W, { baseFont: 'bold' });
    ensure(size * 2.2 + size * LH * Math.min(lines.length, 2));
    y -= level <= 2 ? size * 0.9 : size * 0.6;
    drawLines(lines, { x: M.left, size, kind: 'heading' });
    if (level === 1) {
      page.drawLine({ start: { x: M.left, y: y + 2 }, end: { x: M.left + 48, y: y + 2 }, thickness: 1.5, color: GOLD });
      y -= 6;
    }
    y -= 2;
  };

  const paragraph = (text, { indent = 0, size = BODY, color = INK, italic = false } = {}) => {
    const runs = italic ? inlineRuns(text).map((r) => ({ ...r, italic: !r.code && !r.bold })) : inlineRuns(text);
    drawLines(wrapRuns(runs, size, CONTENT_W - indent), { x: M.left + indent, size, color });
    y -= size * 0.6;
  };

  const list = (b) => {
    const indent = 18;
    (b.items || []).forEach((item, i) => {
      const marker = b.ordered ? `${(Number(b.start) || 1) + i}.` : '•';
      const lines = wrapRuns(inlineRuns(item), BODY, CONTENT_W - indent);
      ensure(BODY * LH);
      const markerY = y - BODY;
      const markerPage = pages();
      drawLines(lines, { x: M.left + indent, size: BODY });
      // The marker goes beside the item's first line (on the page it started).
      const target = pdf.getPage(markerPage - 1);
      const t = clean(marker, 'regular');
      target.drawText(t, { x: M.left + 4, y: markerY, size: BODY, font: fonts.regular, color: INK });
      boxes.push({ page: markerPage, x: M.left + 4, y: markerY, w: width(t, 'regular', BODY), size: BODY, kind: 'list-marker', text: t });
      y -= 2;
    });
    y -= BODY * 0.4;
  };

  const code = (b) => {
    const size = CODE_SIZE;
    const lh = size * 1.35;
    const charW = width('M', 'mono', size);
    const maxChars = Math.max(10, Math.floor((CONTENT_W - 2 * CELL_PAD) / charW));
    const out = [];
    for (const raw of clean(String(b.text || ''), 'mono').split('\n')) {
      if (raw.length <= maxChars) { out.push(raw); continue; }
      for (let i = 0; i < raw.length; i += maxChars) out.push(raw.slice(i, i + maxChars));
    }
    y -= 4;
    let i = 0;
    while (i < out.length) {
      ensure(lh + 2 * CELL_PAD);
      const room = Math.max(1, Math.floor((y - M.bottom - 2 * CELL_PAD) / lh));
      const chunk = out.slice(i, i + room);
      const h = chunk.length * lh + 2 * CELL_PAD;
      page.drawRectangle({ x: M.left, y: y - h, width: CONTENT_W, height: h, color: SHADE });
      let cy = y - CELL_PAD;
      for (const l of chunk) {
        cy -= size;
        if (l) {
          page.drawText(l, { x: M.left + CELL_PAD, y: cy, size, font: fonts.mono, color: INK });
          boxes.push({ page: pages(), x: M.left + CELL_PAD, y: cy, w: width(l, 'mono', size), size, kind: 'code', text: l });
        }
        cy -= lh - size;
      }
      y -= h;
      i += chunk.length;
    }
    y -= BODY * 0.8;
  };

  const table = (b) => {
    const header = (b.header || []).map((c) => String(c ?? ''));
    const rows = (b.rows || []).map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : []));
    const n = Math.max(header.length, ...rows.map((r) => r.length), 1);
    const norm = (r) => Array.from({ length: n }, (_, i) => r[i] || '');
    const all = [norm(header)].concat(rows.map(norm));
    const size = TABLE_SIZE;
    const longestWord = (t, f) => Math.max(0, ...clean(t, f).split(/\s+/).map((w) => width(w, f, size)));
    const minW = [];
    const prefW = [];
    for (let c = 0; c < n; c++) {
      let mn = 24;
      let pf = 24;
      all.forEach((r, ri) => {
        const f = ri === 0 ? 'bold' : 'regular';
        mn = Math.max(mn, Math.min(longestWord(r[c], f), 140) + 2 * CELL_PAD);
        pf = Math.max(pf, width(clean(r[c], f), f, size) + 2 * CELL_PAD);
      });
      minW.push(mn);
      prefW.push(Math.max(pf, mn));
    }
    let widths;
    const sumMin = minW.reduce((a, v) => a + v, 0);
    const sumPref = prefW.reduce((a, v) => a + v, 0);
    if (sumPref <= CONTENT_W) widths = prefW.map((w) => w * (CONTENT_W / sumPref));
    else if (sumMin >= CONTENT_W) widths = minW.map((w) => w * (CONTENT_W / sumMin));
    else widths = minW.map((w, i) => w + (prefW[i] - minW[i]) * ((CONTENT_W - sumMin) / (sumPref - sumMin)));
    const lh = size * 1.3;
    const cellLines = (text, c, bold) => wrapRuns(bold ? [{ text, bold: true }] : inlineRuns(text), size, widths[c] - 2 * CELL_PAD, { baseFont: bold ? 'bold' : 'regular' });
    const rowHeight = (lines) => Math.max(...lines.map((l) => l.length)) * lh + 2 * CELL_PAD - (lh - size) + 2;
    const drawRow = (cells, isHead) => {
      const lines = cells.map((t, c) => cellLines(t, c, isHead));
      let h = rowHeight(lines);
      const fullPage = PAGE_H - M.top - M.bottom;
      if (h > fullPage) {
        const maxLines = Math.max(1, Math.floor((fullPage - 2 * CELL_PAD) / lh));
        for (const l of lines) if (l.length > maxLines) { l.length = maxLines; l[maxLines - 1] = l[maxLines - 1].concat({ text: '…', font: 'regular', w: width('…', 'regular', size) }); }
        h = rowHeight(lines);
      }
      return { lines, h };
    };
    const head = drawRow(all[0], true);
    const paintRow = ({ lines, h }, isHead) => {
      if (isHead) page.drawRectangle({ x: M.left, y: y - h, width: CONTENT_W, height: h, color: TABLE_HEAD });
      let cx = M.left;
      lines.forEach((cl, c) => {
        let cy = y - CELL_PAD;
        for (const l of cl) {
          cy -= size;
          let tx = cx + CELL_PAD;
          for (const seg of l) {
            if (!seg.space) {
              const t = clean(seg.text, seg.font);
              page.drawText(t, { x: tx, y: cy, size, font: fonts[seg.font], color: INK });
              boxes.push({ page: pages(), x: tx, y: cy, w: width(t, seg.font, size), size, kind: 'table-cell', col: c, cellX: cx, cellW: widths[c], text: t });
            }
            tx += seg.w;
          }
          cy -= lh - size;
        }
        cx += widths[c];
      });
      page.drawLine({ start: { x: M.left, y: y - h }, end: { x: M.left + CONTENT_W, y: y - h }, thickness: 0.5, color: RULE });
      y -= h;
    };
    y -= 4;
    ensure(head.h + (all.length > 1 ? drawRow(all[1], false).h : 0));
    paintRow(head, true);
    for (let r = 1; r < all.length; r++) {
      const row = drawRow(all[r], false);
      if (y - row.h < M.bottom) {
        newPage();
        paintRow(head, true);
      }
      paintRow(row, false);
    }
    y -= BODY * 0.8;
  };

  const image = async (b) => {
    let img;
    const data = typeof b.data === 'string' ? Buffer.from(b.data, 'base64') : b.data;
    try {
      img = /png/i.test(b.mime || '') ? await pdf.embedPng(data) : await pdf.embedJpg(data);
    } catch (e) {
      paragraph(`[image could not be read${b.caption ? `: ${b.caption}` : ''}]`, { color: MUTED, italic: true });
      return;
    }
    const scale = Math.min(1, CONTENT_W / img.width, 380 / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    ensure(h + 8);
    y -= h;
    page.drawImage(img, { x: M.left + (CONTENT_W - w) / 2, y, width: w, height: h });
    boxes.push({ page: pages(), x: M.left + (CONTENT_W - w) / 2, y, w, size: h, kind: 'image', text: '' });
    y -= 6;
    if (b.caption) paragraph(b.caption, { size: 9, color: MUTED, italic: true });
    else y -= 6;
  };

  const blocks = Array.isArray(doc.blocks) ? doc.blocks : markdownToBlocks(doc.markdown || '');
  try {
    newPage();
    // Title block.
    drawLines(wrapRuns([{ text: title, bold: true }], 22, CONTENT_W, { baseFont: 'bold' }), { x: M.left, size: 22, kind: 'title' });
    if (doc.subtitle) drawLines(wrapRuns(inlineRuns(doc.subtitle), 11, CONTENT_W), { x: M.left, size: 11, color: MUTED });
    y -= 4;
    page.drawLine({ start: { x: M.left, y }, end: { x: PAGE_W - M.right, y }, thickness: 0.75, color: GOLD });
    y -= 16;
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'heading') heading(b);
      else if (b.type === 'paragraph') paragraph(b.text);
      else if (b.type === 'list') list(b);
      else if (b.type === 'code') code(b);
      else if (b.type === 'table') table(b);
      else if (b.type === 'quote') {
        const top = y;
        const startPage = pages();
        paragraph(b.text, { indent: 12, color: MUTED, italic: true });
        if (pages() === startPage) page.drawLine({ start: { x: M.left + 2, y: top }, end: { x: M.left + 2, y: y + BODY * 0.6 }, thickness: 2, color: GOLD });
      } else if (b.type === 'rule') {
        ensure(12);
        y -= 6;
        page.drawLine({ start: { x: M.left, y }, end: { x: PAGE_W - M.right, y }, thickness: 0.5, color: RULE });
        y -= 6;
      } else if (b.type === 'pagebreak') newPage();
      else if (b.type === 'image') await image(b);
    }
  } catch (e) {
    if (!(e instanceof StopLayout)) throw e;
  }

  const total = pages();
  if (truncated) {
    const last = pdf.getPage(total - 1);
    const note = clean(`Truncated: this document reached the ${maxPages}-page limit; the rest was not included.`, 'italic');
    last.drawText(note, { x: M.left, y: M.bottom - 18, size: 8.5, font: fonts.italic, color: MUTED });
  }
  // Header and footer on every page.
  const stamp = now.toISOString().slice(0, 10);
  const headTitle = (() => {
    let t = clean(title, 'regular');
    while (t.length > 3 && width(t, 'regular', 8.5) > CONTENT_W - 60) t = t.slice(0, -2);
    return t === clean(title, 'regular') ? t : `${t.trimEnd()}…`;
  })();
  for (let i = 0; i < total; i++) {
    const p = pdf.getPage(i);
    p.drawText(PDF_BRAND, { x: M.left, y: PAGE_H - 44, size: 11, font: fonts.bold, color: GOLD });
    p.drawText(headTitle, { x: PAGE_W - M.right - width(headTitle, 'regular', 8.5), y: PAGE_H - 43, size: 8.5, font: fonts.regular, color: MUTED });
    p.drawLine({ start: { x: M.left, y: PAGE_H - 52 }, end: { x: PAGE_W - M.right, y: PAGE_H - 52 }, thickness: 0.5, color: RULE });
    const left = `Made with PG1 · ${stamp}`;
    const right = `Page ${i + 1} of ${total}`;
    p.drawLine({ start: { x: M.left, y: 46 }, end: { x: PAGE_W - M.right, y: 46 }, thickness: 0.5, color: RULE });
    p.drawText(left, { x: M.left, y: 32, size: 8, font: fonts.regular, color: MUTED });
    p.drawText(right, { x: PAGE_W - M.right - width(right, 'regular', 8), y: 32, size: 8, font: fonts.regular, color: MUTED });
  }

  const out = await pdf.save({ useObjectStreams: true });
  if (out.byteLength > maxBytes) throw new PdfTooLargeError(out.byteLength, maxBytes);
  return { bytes: out, pages: total, truncated, title, boxes, margins: { left: M.left, right: PAGE_W - M.right, top: PAGE_H - M.top, bottom: M.bottom } };
}

function oneLine(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
