/**
 * Reading a generated /docs page back as text, for the tests that check a
 * guide's Markdown and its published page (tests/docs-pages.test.mjs,
 * tests/crypto-alert-bot-guide.test.mjs).
 *
 * Deliberately independent of scripts/build-docs.mjs: it reads the HTML
 * the browser gets, not the generator's intermediate output.
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ', trade: '™', middot: '·', ldquo: '“', rdquo: '”', rsquo: '’' };

export function decodeHtml(s) {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e in ENTITIES) return ENTITIES[e];
    if (/^#x/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(Number(e.slice(1)));
    return m;
  });
}

const CODE_BLOCK_RE = /<div class="code">[\s\S]*?<pre tabindex="0"><code(?: class="language-(\w+)")?>([\s\S]*?)<\/code><\/pre><\/div>/g;

// [{ lang, code }] for each fenced block in the Markdown, including blocks
// indented under a list item.
export function mdCodeBlocks(md) {
  const out = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = /^( *)```(\w*)\s*$/.exec(lines[i]);
    if (!open) continue;
    const indent = open[1];
    const body = [];
    for (i++; i < lines.length && lines[i] !== `${indent}\`\`\``; i++) body.push(lines[i].slice(indent.length));
    out.push({ lang: open[2], code: body.join('\n') + '\n' });
  }
  return out;
}

export function pageCodeBlocks(html) {
  return [...html.matchAll(CODE_BLOCK_RE)].map((m) => ({ lang: m[1] || '', code: decodeHtml(m[2]) }));
}

// The page's <main> as Markdown-like text: code blocks as ``` fences,
// inline code in backticks, <strong> as **, <em> as *. The Markdown checks
// in tests/crypto-alert-bot-guide.test.mjs run on this unchanged.
export function pageAsMarkdown(html) {
  const main = html.slice(html.indexOf('<main>'), html.indexOf('</main>'))
    .replace(/<nav class="toc"[\s\S]*?<\/nav>/, '')
    .replace(/<footer>[\s\S]*?<\/footer>/, '');
  const text = main
    .replace(CODE_BLOCK_RE, (m, lang, code) => `\n\`\`\`${lang || ''}\n${code}\`\`\`\n`)
    .replace(/<\/?code>/g, '`')
    .replace(/<\/?strong>/g, '**')
    .replace(/<\/?em>/g, '*')
    .replace(/<(?:td|th)\b[^>]*>/g, '| ')
    .replace(/<\/(?:p|li|tr|h\d)>|<br>/g, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeHtml(text);
}
