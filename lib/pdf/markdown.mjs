// Markdown (as PG1 writes it) to the block list lib/pdf/render.mjs lays out.
//
// Blocks: heading { level, text }, paragraph { text }, list { ordered,
// items, entries } (entries keep each item's nesting level and number),
// table { header, rows }, code { text, lang }, quote { text },
// rule, pagebreak, image { data, mime, caption } (images only come from
// code, never from markdown: a PDF never fetches a URL).
// Inline **bold**, *italic*, `code` and [links](url) are kept as runs by
// inlineRuns(); a link is printed as its text followed by the URL.

const FENCE_RE = /^(\s*)(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_RE = /^(\s*)(?:([-*+•])|(\d{1,3})[.)])\s+(.*)$/;
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
      const j = parseList(lines, i, blocks);
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

// A list from line i: nested items keep their level (from the indentation),
// ordered items their numbers (counted per level, restarting under a new
// parent), and wrapped lines join their item. A blank line ends the list
// unless the next line is an indented item. Pushes one list block:
// { ordered, start, items: [text], entries: [{ text, level, ordered,
// number }] }. Returns the index of the first line after it.
const indentOf = (s) => s.replace(/\t/g, '    ').length;
function parseList(lines, i, blocks) {
  const entries = [];
  const stack = [];
  const counters = [];
  let j = i;
  while (j < lines.length) {
    const m = LIST_RE.exec(lines[j]);
    if (m) {
      const ind = indentOf(m[1]);
      while (stack.length && stack[stack.length - 1] > ind) stack.pop();
      if (!stack.length || stack[stack.length - 1] < ind) stack.push(ind);
      const level = Math.min(stack.length - 1, 5);
      counters.length = level + 1;
      const ordered = !!m[3];
      const number = ordered ? (counters[level] == null ? Number(m[3]) : counters[level] + 1) : null;
      counters[level] = ordered ? number : null;
      entries.push({ text: m[4], level, ordered, number });
      j++;
      continue;
    }
    if (!lines[j].trim()) {
      let k = j + 1;
      while (k < lines.length && !lines[k].trim()) k++;
      const next = k < lines.length ? LIST_RE.exec(lines[k]) : null;
      if (next && indentOf(next[1]) > 0 && entries.length) { j = k; continue; }
      break;
    }
    // A wrapped continuation line of the last item.
    if (/^\s{2,}\S/.test(lines[j]) && entries.length) { entries[entries.length - 1].text += ' ' + lines[j].trim(); j++; continue; }
    break;
  }
  const first = entries[0];
  blocks.push({ type: 'list', ordered: first.ordered, start: first.ordered ? first.number : 1, items: entries.map((e) => e.text), entries });
  return j;
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
