// What a chat reply says about figures and detail, checked in code rather
// than left to the model:
//
//   wantsDetail(prompt)      the operator asked for a full, detailed or
//                            complete answer: written form, never the short
//                            spoken style (DETAIL_DIRECTIVE)
//   extractFigures(text)     the priced items a reply proposes ("Creator:
//                            $45/month", "| Studio | $80 |"), for the
//                            thread's task state
//   figureChanges(...)       figures a new reply changed from what the
//                            thread already proposed, and whether the reply
//                            said so; figureChangeNote() writes the line
//                            appended when it did not
//   sourcesNote(...)         a reply with figures from a web-search turn
//                            gets the search results it can cite; a claim
//                            of search data, or a market figure, with no
//                            source behind it gets a label saying the
//                            figures are PG1's own
//   tierChanges(...)         tier names or package-table columns a reply
//                            changed without saying so (the structure is
//                            tracked in the task state); tierChangeNote()
//                            writes the line appended
//
// Pure functions; api/chat.mjs wires them in.

export const MAX_FIGURES = 12;
const MAX_KEY_CHARS = 60;

// --- detail ---------------------------------------------------------------------

const DETAIL_RE = /\b(?:full|fully|detailed|in[- ]detail|complete|comprehensive|in[- ]depth|thorough|everything|every\s+detail|all\s+the\s+details|long[- ]form|written\s+out)\b/i;
const DETAIL_OBJECT_RE = /\b(?:breakdown|break\s+(?:it|this|that)\s+down|details?|version|write-?up|report|plan|list|analysis|explanation|pricing|proposal|overview|spec(?:ification)?|description|answer|reply|table|tiers?)\b/i;

export function wantsDetail(prompt) {
  const t = String(prompt || '');
  if (/^\s*\//.test(t)) return false;
  return DETAIL_RE.test(t) && DETAIL_OBJECT_RE.test(t);
}

export const DETAIL_DIRECTIVE = '[FULL WRITTEN ANSWER]: The operator asked for a full, detailed or complete answer. Write it in full written form for the screen: "## " headings, a Markdown table for anything with tiers, prices or options, and a short description of each tier or item (what it includes, who it is for, its price and why). Do not shorten it, do not use the brief spoken style and do not end by offering more detail: this is the detail. Brevity applies only to replies read aloud when no detail was asked for.';

// --- figures --------------------------------------------------------------------

const MONEY = String.raw`(?:[$€£]\s?\d[\d,]*(?:\.\d+)?(?:\s?[kKmM])?|\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|usd|eur|gbp|dollars|euros))`;
const PER = String.raw`(?:\s?(?:\/|per\s)\s?(?:month|mo|year|yr|video|clip|call|seat|user|hour|hr|week|wk))?`;
const LABEL = String.raw`[A-Za-z][A-Za-z0-9 +&'()./-]{0,${MAX_KEY_CHARS - 1}}`;

// "| Creator | $45/month | ..." (first money cell after the label cell)
const TABLE_ROW_RE = new RegExp(String.raw`^\s*\|\s*\**(${LABEL}?)\**\s*\|(?:[^|\n]*\|)*?\s*[^|\n]*?(${MONEY}${PER})`, 'gm');
// "Creator: $45", "**Studio** - $80/month", "- Pro tier — €120 per month"
const LINE_RE = new RegExp(String.raw`^\s*(?:[-*•]|\d+[.)])?\s*\**(${LABEL}?)\**\s*(?:\((?:[^)\n]{0,40})\))?\s*(?::|-|–|—|=|at|costs?|for)\s*\**\s*(${MONEY}${PER})`, 'gm');

const STOP_KEYS = new Set(['total', 'price', 'cost', 'tier', 'plan', 'package', 'item', 'name', 'option', 'example', 'note', 'from', 'to', 'up to', 'about', 'around']);

function normKey(label) {
  return String(label || '').replace(/[*_`]/g, '').replace(/\b(?:tier|plan|package)\b/gi, '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, MAX_KEY_CHARS);
}

function normValue(value) {
  return String(value || '').replace(/\s+/g, ' ').replace(/\s?\/\s?/g, '/').trim();
}

// The amount alone, for comparing "$45/month" with "$45 per month".
export function amountOf(value) {
  const m = /\d[\d,]*(?:\.\d+)?/.exec(String(value || ''));
  return m ? Number(m[0].replace(/,/g, '')) : NaN;
}

// [{ key, label, value }] for each priced item, first mention wins.
export function extractFigures(text) {
  const t = String(text || '');
  const out = [];
  const seen = new Set();
  for (const re of [TABLE_ROW_RE, LINE_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t)) && out.length < MAX_FIGURES) {
      const label = m[1].replace(/[*_`]/g, '').trim();
      const key = normKey(label);
      if (!key || key.length < 2 || STOP_KEYS.has(key) || /^[-:| ]+$/.test(key) || seen.has(key)) continue;
      seen.add(key);
      out.push({ key, label: label.slice(0, MAX_KEY_CHARS), value: normValue(m[2]) });
    }
  }
  return out;
}

export function hasFigures(text) {
  return new RegExp(MONEY).test(String(text || ''));
}

// Figures a reply changed: [{ key, label, from, to, explained }]. explained
// is true when the reply itself mentions the old value or says it changed.
export function figureChanges(previous, text) {
  const prev = Array.isArray(previous) ? previous : [];
  const now = extractFigures(text);
  const changes = [];
  for (const f of now) {
    const old = prev.find((p) => p && p.key === f.key);
    if (!old || amountOf(old.value) === amountOf(f.value) || !Number.isFinite(amountOf(f.value))) continue;
    const oldAmount = String(amountOf(old.value));
    const mentionsOld = new RegExp(String.raw`(?:^|[^\d.])${oldAmount.replace('.', '\\.')}(?![\d])`).test(String(text || '').replace(/,/g, ''));
    const saysChanged = new RegExp(String.raw`${f.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\n]{0,120}\b(?:changed|raised|lowered|increased|decreased|up from|down from|was|previously|instead of)\b`, 'i').test(String(text || ''));
    changes.push({ key: f.key, label: f.label, from: old.value, to: f.value, explained: mentionsOld || saysChanged });
  }
  return changes;
}

// The line appended to a reply that changed figures without saying so.
export function figureChangeNote(changes) {
  const silent = (changes || []).filter((c) => !c.explained);
  if (!silent.length) return '';
  const list = silent.map((c) => `${c.label} ${c.from} → ${c.to}`).join('; ');
  return `**Changed from earlier in this thread:** ${list}. The reply above did not explain ${silent.length === 1 ? 'this change' : 'these changes'}; ask PG1 why before relying on the new ${silent.length === 1 ? 'figure' : 'figures'}.`;
}

// Merges a reply's figures into the thread's list: newest value per key,
// at most MAX_FIGURES, the most recently mentioned last.
export function mergeFigures(previous, text, turn = 0) {
  const list = (Array.isArray(previous) ? previous : []).filter((f) => f && f.key);
  for (const f of extractFigures(text)) {
    const i = list.findIndex((p) => p.key === f.key);
    if (i >= 0) list.splice(i, 1);
    list.push({ key: f.key, label: f.label, value: f.value, turn });
  }
  return list.slice(-MAX_FIGURES);
}

// The [TASK STATE] lines for the figures already proposed.
export function figuresBlock(figures) {
  const list = Array.isArray(figures) ? figures.filter((f) => f && f.key) : [];
  if (!list.length) return '';
  return ['Figures PG1 already proposed in this thread (keep them, or say which one changes, old → new, and why):', ...list.map((f) => `  - ${f.label}: ${f.value}`)].join('\n');
}

// --- sources -------------------------------------------------------------------

export const SOURCED_FIGURES_DIRECTIVE = '[SOURCED FIGURES]: Every price, rate, market figure or statistic you give must either come from a web search result you cite in the reply (name the site and give the link to the page itself, never a redirect or search-results link, next to the figure or under a "Sources" heading) or be labelled plainly as PG1\'s own proposal or estimate. Never write "based on web search data", "market data shows" or similar for a figure the search results do not contain. If the search found no figure for something, say so and give your own proposal, labelled as such.';

// [{ url, title }] from Gemini groundingMetadata.groundingChunks.
export function groundingSources(groundingMetadata) {
  const chunks = groundingMetadata && Array.isArray(groundingMetadata.groundingChunks) ? groundingMetadata.groundingChunks : [];
  const out = [];
  for (const c of chunks) {
    const w = c && c.web;
    if (!w || typeof w.uri !== 'string' || !/^https:\/\//i.test(w.uri)) continue;
    if (out.some((s) => s.url === w.uri)) continue;
    out.push({ url: w.uri, title: String(w.title || '').replace(/[\[\]\n]/g, ' ').trim().slice(0, 80) || 'source' });
  }
  return out.slice(0, 8);
}

const SEARCH_CLAIM_RE = /\b(?:based\s+on\s+(?:the\s+)?(?:web\s+)?search(?:\s+(?:data|results))?|according\s+to\s+(?:the\s+)?(?:web\s+)?search|search\s+(?:data|results)\s+(?:show|suggest|indicate)|market\s+data\s+(?:shows|suggests))\b/i;

// The block appended to a reply: with figures and search sources, the
// sources (unless the reply already links them); with a claim of search
// data ("based on web search data") and no source behind it, a label that
// the figures are PG1's own proposal. Otherwise '' (PG1's own prices, from
// [CAPABILITIES], need no label).
export function sourcesNote({ text, sources = [], ownAmounts = [] }) {
  const t = String(text || '');
  const list = Array.isArray(sources) ? sources : [];
  const notes = [];
  if (list.length && (hasFigures(t) || SEARCH_CLAIM_RE.test(t))) {
    if (!/\bsources?\b[^\n]*\n(?:[^\n]*https?:\/\/)/i.test(t)) notes.push(['**Sources (this reply\'s web search):**', ...list.map((s, i) => `${i + 1}. ${sourceLine(s)}`), 'Figures not shown in these sources are PG1\'s own estimates.'].join('\n'));
  } else if (SEARCH_CLAIM_RE.test(t)) notes.push('**Note:** the web search for this reply returned no source for the figures above, so they are PG1\'s own estimates, not market data.');
  else if (unsourcedMarketFigures(t)) notes.push(UNSOURCED_NOTE);
  else if (!/https?:\/\//i.test(t) && extractFigures(t).length) notes.push(OWN_ESTIMATE_NOTE);
  const bench = ownMathAsBenchmark(t, ownAmounts);
  if (bench.length) notes.push(`**Note:** ${bench.map((a) => `${a}`).join(', ')} ${bench.length === 1 ? 'is' : 'are'} PG1's own price calculation, not an industry benchmark.`);
  return notes.join('\n\n');
}

// Item 4: a source with its real URL is a link; one whose link could not
// be resolved (a grounding redirect that did not answer) is shown as its
// title and publication, without a link.
function sourceLine(s) {
  const title = String(s.title || 'source').replace(/[\[\]\n]/g, ' ').trim();
  const pub = String(s.publication || '').trim();
  if (s.url) return `[${title}](${s.url})${pub && pub.toLowerCase() !== title.toLowerCase() ? ` (${pub})` : ''}`;
  return `${title}${pub && pub.toLowerCase() !== title.toLowerCase() ? `, ${pub}` : ''} (no direct link)`;
}

export const OWN_ESTIMATE_NOTE = '**Note:** the prices above are PG1\'s own estimates, not figures from a cited source.';

// Item 5: PG1's own price maths (the thread's proposed prices, the
// registry's minimum prices, its package estimates) presented as an
// industry or market figure. Returns the amounts so presented.
const BENCH_RE = /\b(?:industry|market|benchmark|going\s+rate|standard\s+rate|typical(?:ly)?|average|competitive\s+with|in\s+line\s+with|what\s+(?:agencies|studios|others)\s+charge)\b/i;
export function ownMathAsBenchmark(text, ownAmounts = []) {
  const own = new Set((ownAmounts || []).map(Number).filter((n) => Number.isFinite(n) && n > 0));
  if (!own.size) return [];
  const out = [];
  for (const sent of String(text || '').split(/\n+|(?<=[.!?])\s+/)) {
    if (!BENCH_RE.test(sent) || /https?:\/\//i.test(sent)) continue;
    const re = new RegExp(MONEY, 'g');
    let m;
    while ((m = re.exec(sent))) {
      const a = amountOf(m[0]);
      if (own.has(a) && !out.includes(m[0].trim())) out.push(m[0].trim());
    }
  }
  return out;
}

// Item 5: a market rate, average or statistic with no link behind it is
// labelled as PG1's estimate, even when the reply never claimed search
// data ("agencies charge 2,000 USD"); so are PG1's own priced items when
// no source backs the reply (OWN_ESTIMATE_NOTE).
const MARKET_RE = /\b(?:market\s+(?:rates?|prices?|average|size|value|data)|industry\s+(?:average|standard|rates?|benchmarks?)|competitors?\s+(?:charge|price|offer)|(?:agencies|studios|freelancers|production\s+companies)\s+(?:typically\s+|usually\s+|often\s+)?(?:charge|bill|ask)|typical(?:ly)?\s+(?:costs?|charges?|prices?|rates?)|on\s+average|average\s+(?:prices?|costs?|rates?|budgets?)|(?:studies|surveys|reports|research)\s+(?:show|find|suggest)|according\s+to\s+(?!pg1\b)[a-z])/i;
const STAT_RE = /\d(?:[\d,.]*)\s?(?:%|percent\b)|\b\d[\d,.]*\s?(?:billion|million)\b/i;
export const UNSOURCED_NOTE = '**Note:** the market figures above have no cited source, so treat them as PG1\'s own estimates, not market data.';

export function unsourcedMarketFigures(text) {
  const t = String(text || '');
  if (/https?:\/\//i.test(t)) return false;
  return t.split(/\n+|(?<=[.!?])\s+/).some((s) => MARKET_RE.test(s) && (hasFigures(s) || STAT_RE.test(s)));
}

// --- tiers (item 6) -----------------------------------------------------------------

const ADD_ON_RE = /\b(?:add-?ons?|extras?|rush|revisions?|delivery|options?|upgrades?|per\s+extra|overage)\b/i;
const TIER_WORD_RE = /\b(?:tier|plan|package)s?\b/i;

// Item 6: the package structure a reply sets out (two or more priced
// items, under tier or package words or in a table): its tier names and
// the columns of its priced table. null when the reply sets out none.
export function packageStructure(text) {
  const t = String(text || '');
  const figs = extractFigures(t).filter((f) => !ADD_ON_RE.test(f.label));
  if (figs.length < 2 || (!TIER_WORD_RE.test(t) && !/^\s*\|/m.test(t))) return null;
  let columns = [];
  const lines = t.split('\n');
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i]) || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) continue;
    const body = lines.slice(i + 2).filter((l) => /^\s*\|/.test(l));
    if (!body.some((l) => new RegExp(MONEY).test(l))) continue;
    columns = lines[i].split('|').map((c) => c.replace(/[*_`]/g, '').trim()).filter(Boolean).slice(0, 8);
    break;
  }
  return { tiers: figs.map((f) => f.label), columns };
}

const normCol = (c) => String(c || '').toLowerCase().replace(/\s+/g, ' ').trim();
const EXPLAINED_RE = /\b(?:renam\w*|replac\w*|instead\s+of|now\s+called|merged?|split|dropp\w*|remov\w*|added?\s+(?:a|an|the)?\s*(?:new\s+)?(?:tier|plan|package|column)|new\s+(?:tier|plan|package)\s+(?:names?|structure)|restructur\w*|simplif\w*|no\s+longer)\b/i;

// Tier names and table columns a reply dropped or introduced compared with
// the structure already set out in this thread, without saying so.
// `previous` is the thread's figures (tier names) and `columns` its table
// columns. { dropped, added, droppedColumns, addedColumns } or null.
export function tierChanges(previous, text, { columns = [] } = {}) {
  const prev = (Array.isArray(previous) ? previous : []).filter((f) => f && f.key && !ADD_ON_RE.test(f.label));
  const now = packageStructure(text);
  if (!now || prev.length < 2) return null;
  const nowKeys = new Set(extractFigures(text).map((f) => f.key));
  const prevKeys = new Set(prev.map((f) => f.key));
  const dropped = prev.filter((f) => !nowKeys.has(f.key)).map((f) => f.label);
  const added = extractFigures(text).filter((f) => !prevKeys.has(f.key) && !ADD_ON_RE.test(f.label)).map((f) => f.label);
  const prevCols = (columns || []).map(normCol);
  const nowCols = now.columns.map(normCol);
  const droppedColumns = prevCols.length && nowCols.length ? (columns || []).filter((c) => !nowCols.includes(normCol(c))) : [];
  const addedColumns = prevCols.length && nowCols.length ? now.columns.filter((c) => !prevCols.includes(normCol(c))) : [];
  if (!dropped.length && !droppedColumns.length && !addedColumns.length) return null;
  if (EXPLAINED_RE.test(String(text || ''))) return null;
  return { dropped, added, droppedColumns, addedColumns };
}

export function tierChangeNote(change) {
  if (!change) return '';
  const parts = [];
  if (change.dropped.length && change.added.length) parts.push(`earlier in this thread the tiers were ${change.dropped.join(', ')}; this reply uses ${change.added.join(', ')}`);
  else if (change.dropped.length) parts.push(`this reply leaves out ${change.dropped.join(', ')}, set out earlier in this thread`);
  if (change.droppedColumns.length || change.addedColumns.length) parts.push(`the package table ${[change.droppedColumns.length ? `drops ${change.droppedColumns.join(', ')}` : '', change.addedColumns.length ? `adds ${change.addedColumns.join(', ')}` : ''].filter(Boolean).join(' and ')}`);
  return `**Package structure changed:** ${parts.join('; ')}, without saying why. Keep one set of tier names and the same structure (what each tier includes, its price), or say what changed.`;
}

// --- command forms ----------------------------------------------------------------

export const COMMAND_FORMS_DIRECTIVE = '[COMMAND FORMS]: The app turns every real command you mention into a button under your reply, and the operator can also just say what they want ("lab status", "show the lab report", "make it a PDF"). So never tell them to type or run a command: offer the action in plain words and put the command in backticks once, exactly in a form listed under [COMMAND REGISTRY], with its argument filled in when you know it (for a lab experiment its 8-character id, for example `/lab report e2981021`). Never invent a command, flag or subcommand, and never drop a required argument; if you do not know the id, give the command that lists them (`/lab status`). Never offer as a command something you can do in this reply.';
