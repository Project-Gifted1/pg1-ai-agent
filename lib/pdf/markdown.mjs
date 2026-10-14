// Markdown (as PG1 writes it) to the block list lib/pdf/render.mjs lays out.
//
// Blocks: heading { level, text }, paragraph { text }, list { ordered,
// items }, table { header, rows }, code { text, lang }, quote { text },
// rule, pagebreak, image { data, mime, caption } (images only come from
// code, never from markdown: a PDF never fetches a URL).
// Inline **bold**, *italic*, `code` and [links](url) are kept as runs by
// inlineRuns(); a link is printed as its text followed by the URL.

const FENCE_RE = /^(\s*)(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_RE = /^\s*(?:([-*+])|(\d{1,3})[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const RULE_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

export function markdownToBlocks(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  const flush = () => {
    if (para.length) blocks.push({ type: 'paragraph', text: para.join(' ').replace(/\s+/g, ' ').trim() });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flush();
      const body = [];
      let j = i + 1;
      while (j < lines.length && !new RegExp(`^\\s*${fence[2]}\\s*$`).test(lines[j])) body.push(lines[j++]);
      blocks.push({ type: 'code', text: body.join('\n'), lang: fence[3] || '' });
      i = j;
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    if (/^\s*\\pagebreak\s*$|^\s*<!--\s*pagebreak\s*-->\s*$/i.test(line)) { flush(); blocks.push({ type: 'pagebreak' }); continue; }
    const h = HEADING_RE.exec(line);
    if (h) { flush(); blocks.push({ type: 'heading', level: h[1].length, text: h[2] }); continue; }
    if (RULE_RE.test(line)) { flush(); blocks.push({ type: 'rule' }); continue; }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      flush();
      const header = splitRow(line);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes('|') && lines[j].trim()) rows.push(splitRow(lines[j++]));
      blocks.push({ type: 'table', header, rows });
      i = j - 1;
      continue;
    }
    const li = LIST_RE.exec(line);
    if (li) {
      flush();
      const ordered = !!li[2];
      const items = [li[3]];
      const start = ordered ? Number(li[2]) : 1;
      let j = i + 1;
      while (j < lines.length) {
        const next = LIST_RE.exec(lines[j]);
        if (next && !!next[2] === ordered) { items.push(next[3]); j++; continue; }
        // A wrapped continuation line of the last item.
        if (lines[j].trim() && /^\s{2,}\S/.test(lines[j]) && !LIST_RE.test(lines[j])) { items[items.length - 1] += ' ' + lines[j].trim(); j++; continue; }
        break;
      }
      blocks.push({ type: 'list', ordered, start, items });
      i = j - 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const q = [];
      let j = i;
      while (j < lines.length && /^\s*>/.test(lines[j])) q.push(lines[j++].replace(/^\s*>\s?/, ''));
      blocks.push({ type: 'quote', text: q.join(' ').trim() });
      i = j - 1;
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

// Inline runs: [{ text, bold, italic, code }]. Links become "text (url)".
export function inlineRuns(text) {
  const src = String(text || '').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (m, t, u) => (t === u ? u : `${t} (${u})`));
  const runs = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) runs.push({ text: src.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith('`')) runs.push({ text: tok.slice(1, -1), code: true });
    else if (tok.startsWith('**') || tok.startsWith('__')) runs.push({ text: tok.slice(2, -2), bold: true });
    else runs.push({ text: tok.slice(1, -1), italic: true });
    last = m.index + tok.length;
  }
  if (last < src.length) runs.push({ text: src.slice(last) });
  return runs.filter((r) => r.text);
}

export function plainText(text) {
  return inlineRuns(text).map((r) => r.text).join('');
}
