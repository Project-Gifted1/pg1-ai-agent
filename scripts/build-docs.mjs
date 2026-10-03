/**
 * Builds the public integration-guide pages from their Markdown sources.
 *
 *   docs/integrations/crypto-alert-bot.md -> public/docs/crypto-alert-bot/index.html
 *
 * The Markdown file is the single source of truth; the HTML is generated
 * and committed. tests/docs-pages.test.mjs fails if the committed page and
 * the Markdown drift apart, so after editing a guide run:
 *
 *   npm run docs:build
 *
 * The page follows the /playground rules: no inline scripts or styles (the
 * CSS and the copy-button script are files under public/docs/), nothing
 * third-party, no cookies, no analytics.
 *
 * Only the Markdown the guides use is supported: #/##/### headings, ---,
 * paragraphs, "- " lists (with indented continuation blocks), pipe tables,
 * fenced code blocks, and inline `code`, **bold**, *italic* and [links](…).
 * Anything else is rendered as a plain paragraph.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_URL = 'https://pg1-ai-agent.vercel.app';

export const DOC_PAGES = [
  {
    source: 'docs/integrations/crypto-alert-bot.md',
    output: 'public/docs/crypto-alert-bot/index.html',
    route: '/docs/crypto-alert-bot',
    description: 'Integration guide: a Telegram alert bot in Node that screens wallets with PG1\'s free wallet sanctions and wallet age checks over A2A before it posts an alert.'
  }
];

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// GitHub's heading anchors, so links written for the Markdown file
// (e.g. #8-rest-the-playground-endpoint) work on the page too.
function slugify(text, seen) {
  const base = text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
  const n = seen.get(base) || 0;
  seen.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

function inline(text) {
  return text.split(/(`[^`]*`)/).map((part) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
    return escapeHtml(part)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  }).join('')
    // Bold or links that wrap a code span, e.g. **Allowed `chain` values:**
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

const plain = (text) => text.replace(/`/g, '').replace(/\*\*?/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

function codeBlock(lang, code) {
  const label = lang || 'text';
  const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
  return `<div class="code"><div class="code-bar"><span class="code-lang">${escapeHtml(label)}</span>` +
    `<button type="button" class="copy" data-copy hidden>Copy</button></div>` +
    `<pre tabindex="0"><code${cls}>${escapeHtml(code)}</code></pre></div>`;
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function table(lines) {
  const head = splitRow(lines[0]);
  const rows = lines.slice(2).map(splitRow);
  return '<div class="table-wrap" tabindex="0"><table>\n<thead><tr>' + head.map((c) => `<th scope="col">${inline(c)}</th>`).join('') + '</tr></thead>\n<tbody>\n' +
    rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('\n') + '\n</tbody>\n</table></div>';
}

// Block-level parse. Returns { html, headings }.
function blocks(lines, ctx) {
  const out = [];
  let i = 0;
  const isBlank = (l) => l.trim() === '';
  const startsBlock = (l) => /^(#{1,3} |```|---\s*$|- |\|)/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }

    let m;
    if ((m = /^```(\w*)\s*$/.exec(line))) {
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence
      out.push(codeBlock(m[1], body.join('\n') + '\n'));
      continue;
    }
    if ((m = /^(#{1,3}) (.*)$/.exec(line))) {
      const level = m[1].length;
      const text = m[2].trim();
      if (level === 1) {
        ctx.title = plain(text);
      } else {
        const id = slugify(plain(text), ctx.seen);
        ctx.headings.push({ level, id, html: inline(text), text: plain(text) });
        out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      }
      i++;
      continue;
    }
    if (/^---\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (line.startsWith('|') && i + 1 < lines.length && /^\|[\s|:-]+\|\s*$/.test(lines[i + 1])) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      out.push(table(rows));
      continue;
    }
    if (line.startsWith('- ')) {
      const items = [];
      while (i < lines.length && lines[i].startsWith('- ')) {
        const item = [lines[i].slice(2)];
        i++;
        // Continuation: indented lines, possibly separated by blank lines.
        while (i < lines.length) {
          if (/^ {2,}\S/.test(lines[i])) { item.push(lines[i].replace(/^ {2}/, '')); i++; continue; }
          if (isBlank(lines[i])) {
            let j = i;
            while (j < lines.length && isBlank(lines[j])) j++;
            if (j < lines.length && /^ {2,}\S/.test(lines[j])) { item.push(''); i = j; continue; }
          }
          break;
        }
        items.push(item);
      }
      out.push('<ul>\n' + items.map((item) => {
        // A single-paragraph item stays inline; anything more is parsed as blocks.
        const firstBlank = item.indexOf('');
        if (firstBlank === -1) return `<li>${inline(item.join(' '))}</li>`;
        const rest = blocks(item.slice(firstBlank), ctx).html;
        return `<li>${inline(item.slice(0, firstBlank).join(' '))}\n${rest}</li>`;
      }).join('\n') + '\n</ul>');
      continue;
    }
    const para = [];
    while (i < lines.length && !isBlank(lines[i]) && !(para.length && startsBlock(lines[i]))) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return { html: out.join('\n') };
}

export function renderMarkdown(md) {
  const ctx = { title: '', headings: [], seen: new Map() };
  const { html } = blocks(md.replace(/\r\n/g, '\n').split('\n'), ctx);
  return { title: ctx.title, headings: ctx.headings, html };
}

const SHIELD = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="169.76 -2 104 104" width="104" height="104" role="img" aria-label="PG1">
      <title>PG1</title>
      <path d="M221.76 0L262.5 15.2V47.3C262.5 73.9 245.1 91.85 221.76 100C198.4 91.85 181 73.9 181 47.3V15.2Z" fill="#f3c623"/>
      <path d="M220 20H233V72H220V37.5L208.5 43.5V31Z" fill="#0a0a0b"/>
    </svg>`;

// Same policy as /playground (vercel.json sets it as a header as well).
export const DOCS_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'";

export function renderPage(md, page) {
  const { title, headings, html } = renderMarkdown(md);
  const toc = headings.filter((h) => h.level === 2)
    .map((h) => `      <li><a href="#${h.id}">${h.html}</a></li>`).join('\n');
  return `<!DOCTYPE html>
<!-- Generated by scripts/build-docs.mjs from ${page.source}. Do not edit by hand: edit the Markdown and run npm run docs:build. -->
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta http-equiv="Content-Security-Policy" content="${DOCS_CSP}">
  <meta name="referrer" content="no-referrer">
  <meta name="theme-color" content="#0a0a0b">
  <meta name="color-scheme" content="dark">
  <title>${escapeHtml(title)} · PG1</title>
  <meta name="description" content="${escapeHtml(page.description)}">
  <link rel="canonical" href="${BASE_URL}${page.route}">
  <link rel="icon" href="/brand/pg1-shield.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/docs/docs.css">
  <script src="/docs/docs.js" defer></script>
</head>
<body>
<main>
  <header class="doc-header">
    ${SHIELD}
    <div>
      <p class="kicker">PG1 integration guide</p>
      <h1>${escapeHtml(title)}</h1>
    </div>
  </header>

  <nav class="toc" aria-label="Contents">
    <p class="toc-title">Contents</p>
    <ul>
${toc}
    </ul>
  </nav>

  <article class="doc">
${html}
  </article>

  <footer>
    <p>Try the checks in your browser on the <a href="/playground">playground</a>. Endpoints, tools and test inputs: <a href="/about">About PG1</a>.</p>
    <p>Project-Gifted1&trade; &middot; PG1 Threat Intelligence</p>
  </footer>
</main>
</body>
</html>
`;
}

export function buildPage(page, root = ROOT) {
  return renderPage(fs.readFileSync(path.join(root, page.source), 'utf8'), page);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const page of DOC_PAGES) {
    const html = buildPage(page);
    const out = path.join(ROOT, page.output);
    const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
    if (current === html) { console.log(`up to date: ${page.output}`); continue; }
    if (check) { console.error(`stale: ${page.output} (run npm run docs:build)`); stale++; continue; }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, html);
    console.log(`wrote ${page.output}`);
  }
  if (stale) process.exit(1);
}
