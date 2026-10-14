// Rules for what PG1 puts in front of a client, enforced in code:
//
//   resolveSources(list)        item 4: a web-search source is shown with
//                               its real URL. Gemini grounding returns
//                               redirect links (vertexaisearch.cloud.google
//                               .com/grounding-api-redirect/...); each is
//                               followed once, without its body, and a link
//                               that does not resolve to a real https URL
//                               is dropped rather than shown.
//   clientTitle(title)          item 7: no "Agreement" (or contract, terms,
//                               statement of work) titles: PG1 does not
//                               draft contracts, so the document is a
//                               proposal
//   isClientDocument(...)       whether a PDF is meant for a client
//   scrubPrivateContext(md)     item 8: no private context in a client
//                               document: engine and provider names, PG1's
//                               own costs and margins, configuration names,
//                               ids, operator-only notes
//   prepareClientDocument(md)   all of the above plus the offer guard
//                               (lib/capabilities/offers.mjs): lines that
//                               offer what PG1 may not are left out; the
//                               operator is told what was changed

import { offerViolations } from './capabilities/offers.mjs';

// --- item 4: real source URLs ---------------------------------------------------

const GROUNDING_RE = /^https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\//i;

export function isGroundingRedirect(url) {
  return GROUNDING_RE.test(String(url || ''));
}

function realUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (u.protocol !== 'https:' || isGroundingRedirect(u.href) || /(^|\.)(?:google\.com|googleusercontent\.com)$/i.test(u.hostname) && /\/(?:url|search)\b/.test(u.pathname)) return null;
    return u.href;
  } catch (e) {
    return null;
  }
}

// [{ url, title }] with every grounding redirect replaced by where it
// points, or left out. Never throws; at most `timeoutMs` in total.
export async function resolveSources(sources, { fetchImpl = globalThis.fetch, timeoutMs = 2500 } = {}) {
  const list = Array.isArray(sources) ? sources.filter((s) => s && typeof s.url === 'string') : [];
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  try {
    const out = await Promise.all(list.map(async (s) => {
      if (!isGroundingRedirect(s.url)) {
        const direct = realUrl(s.url);
        return direct ? { ...s, url: direct } : null;
      }
      try {
        const res = await fetchImpl(s.url, { method: 'HEAD', redirect: 'manual', signal: deadline.signal });
        const loc = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
        const target = loc ? realUrl(new URL(loc, s.url).href) : null;
        return target ? { ...s, url: target } : null;
      } catch (e) {
        return null;
      }
    }));
    const seen = new Set();
    return out.filter((s) => s && !seen.has(s.url) && seen.add(s.url));
  } finally {
    clearTimeout(timer);
  }
}

// --- item 7: titles ---------------------------------------------------------------

const AGREEMENT_RE = /\b(?:master\s+services?\s+agreement|service\s+level\s+agreement|non[- ]disclosure\s+agreement|statement\s+of\s+work|terms\s+(?:of\s+service|and\s+conditions|&\s+conditions)|agreement|contract|nda|sow|msa)\b/gi;

export function hasAgreementTitle(title) {
  AGREEMENT_RE.lastIndex = 0;
  return AGREEMENT_RE.test(String(title || ''));
}

// "PG1 Studio Service Agreement" -> "PG1 Studio Service Proposal".
export function clientTitle(title) {
  const t = String(title || '').trim();
  if (!hasAgreementTitle(t)) return t;
  let out = t.replace(AGREEMENT_RE, 'Proposal').replace(/\b(Proposal)(?:\s+\1)+\b/gi, 'Proposal').replace(/\s{2,}/g, ' ').trim();
  if (/^proposal$/i.test(out)) out = 'Proposal';
  return out;
}

// Every heading in a markdown document, renamed the same way.
export function clientHeadings(markdown) {
  return String(markdown || '').replace(/^(\s{0,3}#{1,6}\s+)(.+)$/gm, (m, hashes, text) => hashes + clientTitle(text));
}

// --- which documents are for clients ----------------------------------------------

const CLIENT_RE = /\b(?:clients?|customers?|prospects?|proposals?|offers?|quotes?|quotations?|packages?|pricing\s+(?:sheet|page|table)|rate\s+card|price\s+list|pitch|brochure|one[- ]pager|tiers?)\b/i;
const OPERATOR_RE = /\b(?:internal|for\s+me|my\s+own|operator|private|cost\s+breakdown|margins?|usage\s+report|spend)\b/i;

export function isClientDocument({ request = '', markdown = '' } = {}) {
  const r = String(request || '');
  if (OPERATOR_RE.test(r)) return false;
  if (CLIENT_RE.test(r)) return true;
  const head = String(markdown || '').split('\n').slice(0, 12).join('\n');
  return CLIENT_RE.test(head) && !OPERATOR_RE.test(head);
}

// --- item 8: private context ------------------------------------------------------

const PRIVATE_RULES = Object.freeze([
  { id: 'engine_names', reason: 'named an engine or provider', re: /\b(?:replicate|elevenlabs|eleven\s?labs|gemini|google\s+ai|vertex|lyria|veo|imagen|omni\s+flash|kling|kwaivgi|flux|kontext|black\s+forest\s+labs|cartesia|sonic-\d|claude|anthropic|openai|gpt-?\d|openrouter|demucs|basic-pitch|topaz|whisper|supabase|vercel|github\s+actions)\b/i },
  { id: 'internal_costs', reason: 'gave PG1\'s own costs or margin', re: /\b(?:our|pg1['’]?s|internal|underlying|provider|engine|compute|api)\s+(?:costs?|spend|rates?)\b|\b(?:unit\s+cost|cost\s+basis|cost\s+price|cogs|gross\s+margin|margins?|mark[- ]?ups?|1\.5\s?x|cost\s+(?:to|for)\s+pg1)\b/i },
  { id: 'config_names', reason: 'named a configuration setting', re: /\b(?:PG1_[A-Z0-9_]+|[A-Z][A-Z0-9]*_(?:API_)?(?:KEY|TOKEN|SECRET|URL)(?:_[A-Z0-9]+)?)\b/ },
  { id: 'internal_ids', reason: 'carried an internal id', re: /\b(?:request\s+id|trace\s*id|req_[a-z0-9]{6,}|experiment\s+[0-9a-f]{8}|film\s+[0-9a-f]{8}|job\s+[0-9a-f]{8})\b/i },
  { id: 'operator_notes', reason: 'was an operator-only note', re: /\b(?:offer\s+check|licence\s+under\s+review|license\s+under\s+review|operator\s+only|note\s+to\s+self|internal\s+note|changed\s+from\s+earlier\s+in\s+this\s+thread|ask\s+pg1\s+why)\b/i }
]);

// { markdown, removed: [{ id, reason, line }] }. A table row or list item
// that carries private context is dropped whole; so is a paragraph line.
export function scrubPrivateContext(markdown) {
  const removed = [];
  const lines = String(markdown || '').split('\n');
  const kept = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) inFence = !inFence;
    const hit = PRIVATE_RULES.find((r) => r.re.test(line));
    if (hit) { removed.push({ id: hit.id, reason: hit.reason, line: line.trim().slice(0, 160) }); continue; }
    kept.push(line);
  }
  return { markdown: tidy(kept.join('\n')), removed };
}

// Collapses the gaps left behind and drops a heading with nothing under it.
function tidy(md) {
  const lines = md.replace(/\n{3,}/g, '\n\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const h = /^\s{0,3}(#{1,6})\s/.exec(lines[i]);
    if (h) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const next = j < lines.length ? /^\s{0,3}(#{1,6})\s/.exec(lines[j]) : null;
      if (j >= lines.length || (next && next[1].length <= h[1].length)) continue;
    }
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

// --- everything together ----------------------------------------------------------

// { title, markdown, changes: [string] } for a client document: the title
// and headings as proposals, private context out, and lines that offer
// what PG1 may not left out. `changes` is for the operator's chat reply,
// never for the document.
export function prepareClientDocument({ title = '', markdown = '' } = {}) {
  const changes = [];
  const newTitle = clientTitle(title);
  if (newTitle !== String(title || '').trim()) changes.push(`Titled "${newTitle}" rather than "${String(title).trim()}": PG1 writes proposals, not agreements.`);
  let md = clientHeadings(markdown);
  const scrub = scrubPrivateContext(md);
  md = scrub.markdown;
  const reasons = [...new Set(scrub.removed.map((r) => r.reason))];
  if (scrub.removed.length) changes.push(`Left out ${scrub.removed.length} line${scrub.removed.length === 1 ? '' : 's'} that ${reasons.join(', ')}.`);
  const dropped = [];
  md = md.split('\n').filter((line) => {
    const v = offerViolations(line);
    if (!v.length) return true;
    dropped.push(...v);
    return false;
  }).join('\n');
  if (dropped.length) changes.push(`Left out what PG1 may not offer: ${[...new Set(dropped.map((v) => `${v.label} (${v.reason})`))].join('; ')}.`);
  return { title: newTitle, markdown: tidy(md), changes };
}
