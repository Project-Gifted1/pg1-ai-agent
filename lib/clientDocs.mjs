// Rules for what PG1 puts in front of a client, enforced in code:
//
//   resolveSources(list)        item 4: a web-search source is shown with
//                               its real URL. Gemini grounding returns
//                               redirect links (vertexaisearch.cloud.google
//                               .com/grounding-api-redirect/...); each is
//                               followed once, without its body. One that
//                               does not resolve to a real https URL is
//                               shown as its title and publication without
//                               a link, never as the redirect.
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
import { whiteLabel, namesProvider, PROVIDER_NAME_RE } from './whiteLabel.mjs';

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

// [{ url, title, publication }]: every grounding redirect replaced by where
// it points, or by url: null (title and publication only). Never throws; at
// most `timeoutMs` in total.
export async function resolveSources(sources, { fetchImpl = globalThis.fetch, timeoutMs = 2500 } = {}) {
  const list = Array.isArray(sources) ? sources.filter((s) => s && typeof s.url === 'string') : [];
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  try {
    const out = await Promise.all(list.map(async (s) => {
      const unlinked = { title: s.title, url: null, publication: publicationOf(s.title) };
      if (!isGroundingRedirect(s.url)) {
        const direct = realUrl(s.url);
        return direct ? { title: s.title, url: direct, publication: hostOf(direct) } : unlinked;
      }
      try {
        const res = await fetchImpl(s.url, { method: 'HEAD', redirect: 'manual', signal: deadline.signal });
        const loc = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
        const target = loc ? realUrl(new URL(loc, s.url).href) : null;
        return target ? { title: s.title, url: target, publication: hostOf(target) } : unlinked;
      } catch (e) {
        return unlinked;
      }
    }));
    const seen = new Set();
    return out.filter((s) => {
      const k = s.url || `title:${s.title}`;
      return !seen.has(k) && seen.add(k);
    });
  } finally {
    clearTimeout(timer);
  }
}

const hostOf = (u) => new URL(u).hostname.replace(/^www\./, '');
// Gemini gives a grounding source's site as its title ("reuters.com").
const publicationOf = (title) => (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(String(title || '').trim()) ? String(title).trim().replace(/^www\./, '') : '');

// A redirect link written into a document becomes its text alone.
export function stripRedirectLinks(markdown) {
  return String(markdown || '')
    .replace(/\[([^\]]+)\]\((https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\/[^)\s]*)\)/gi, '$1')
    .replace(/https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\/\S*/gi, '');
}

// --- item 7: titles ---------------------------------------------------------------

const AGREEMENT_RE = /\b(?:master\s+services?\s+agreement|service\s+level\s+agreement|non[- ]disclosure\s+agreement|statement\s+of\s+work|terms\s+(?:of\s+service|and\s+conditions|&\s+conditions)|agreement|contract|nda|sow|msa)\b/gi;

export function hasAgreementTitle(title) {
  AGREEMENT_RE.lastIndex = 0;
  return AGREEMENT_RE.test(String(title || ''));
}

// "PG1 Studio Service Agreement" -> "PG1 Studio Service Proposal". With
// `offer` (the offer's own name), a title left with nothing but the word
// "Proposal" becomes "<offer> proposal".
export function clientTitle(title, { offer = '' } = {}) {
  const t = String(title || '').trim();
  if (!hasAgreementTitle(t)) return t;
  let out = t.replace(AGREEMENT_RE, 'Proposal').replace(/\b(Proposal)(?:\s+\1)+\b/gi, 'Proposal').replace(/\s{2,}/g, ' ').trim();
  // Only generic words left ("Service Proposal", "Master Proposal"): the
  // offer names it.
  const substantive = out.replace(/\b(?:proposal|services?|client|customer|master|general|standard|production|the|a|an|of|and|for|pg1)\b/gi, '').replace(/[\s:–—-]+/g, '');
  if (!substantive) out = offer ? `${offer} proposal` : 'Proposal';
  else if (/^proposal\s*[:–—-]\s*(.+)$/i.test(out)) out = `${out.replace(/^proposal\s*[:–—-]\s*/i, '')} proposal`;
  return out;
}

// The operator asked for an agreement or contract in so many words: the
// title is theirs to choose.
export function asksForAgreement(request) {
  return /\b(?:agreement|contract|terms\s+(?:of\s+service|and\s+conditions)|statement\s+of\s+work|sow|msa|nda)\b/i.test(String(request || ''));
}

// What a proposal is titled by: the offer itself. The first heading that
// names a package, tier, plan or offer, else the tier names, else the PG1
// product the document is about.
const GENERIC_TITLE_RE = /^(?:pg1\s+(?:reply|document)|proposal|document|untitled|overview|summary|introduction|pricing|prices?|packages?|tiers?)$/i;
export function offerHeading(markdown) {
  for (const m of String(markdown || '').matchAll(/^\s{0,3}#{1,3}\s+(.+?)\s*#*\s*$/gm)) {
    const h = m[1].replace(/[*_`]/g, '').trim();
    if (/\b(?:packages?|tiers?|plans?|offers?|bundles?|retainers?)\b/i.test(h) && !GENERIC_TITLE_RE.test(h) && !hasAgreementTitle(h)) return h;
  }
  return '';
}

export function offerName(markdown) {
  const md = String(markdown || '');
  const heading = offerHeading(md);
  if (heading) return heading;
  const product = /\b(?:music|track|song|stems?|sound|audio|voice)\b/i.test(md) && !/\b(?:video|film|clip|footage)\b/i.test(md) ? 'PG1 Sound' : 'PG1 Studio';
  return `${product} packages`;
}

export function isGenericTitle(title) {
  return GENERIC_TITLE_RE.test(String(title || '').trim());
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

// Private details from the operator's own messages: the people in their
// life ("my sister", "my sister Anna") and their own circumstances (money,
// health, home). { phrases: [string], names: [string] } for scrubbing.
const RELATION = String.raw`(?:sister|brother|sibling|mum|mom|mother|dad|father|parents?|wife|husband|partner|spouse|girlfriend|boyfriend|fianc[ée]e?|ex|son|daughter|kids?|children|child|baby|cousin|aunt|uncle|niece|nephew|grand(?:ma|pa|mother|father|parents?)|in-laws?|family|friend|best\s+friend|neighbou?r|flatmate|roommate|landlord|landlady|boss|manager|colleague|therapist|doctor|lawyer)`;
const PERSONAL_RE = new RegExp(String.raw`\b(?:my|our)\s+(?:(?:little|big|older|younger|elder|late|ex-?)\s+)?${RELATION}\b`, 'gi');
const NAME_AFTER_RE = new RegExp(String.raw`\b(?:[Mm]y|[Oo]ur|MY|OUR)\s+(?:(?:little|big|older|younger|elder|late|ex-?)\s+)?${RELATION}\s*,?\s+(?:called\s+|named\s+)?([A-Z][a-z]{1,20})\b`, 'g');
const CIRCUMSTANCE_RE = /\b(?:my|our|i['’]?m|i\s+am|i\s+have|i['’]?ve)\s+(?:(?:in\s+)?debt|broke|rent|mortgage|loan|overdraft|bills?|salary|divorce|diagnos\w*|illness|cancer|depress\w*|anxiety|pregnan\w*|health|therapy|medication|bank\s+balance|savings)\b/gi;
const NOT_NAMES = new Set(['The', 'And', 'But', 'She', 'He', 'They', 'Who', 'Is', 'Was', 'Has', 'Will', 'Can', 'Wants', 'Said', 'Says', 'Runs', 'Owns']);

export function personalContext(operatorText) {
  const t = String(operatorText || '');
  const phrases = [...new Set([...(t.match(PERSONAL_RE) || []), ...(t.match(CIRCUMSTANCE_RE) || [])].map((p) => p.toLowerCase().replace(/\s+/g, ' ')))];
  const names = [...new Set([...t.matchAll(NAME_AFTER_RE)].map((m) => m[1]).filter((n) => !NOT_NAMES.has(n)))];
  return { phrases, names };
}

// Any line of a client document that mentions a relation or circumstance
// of the operator's (in any person: "your sister", "the owner's sister"),
// or a name the operator gave one, is left out.
function personalRules(ctx) {
  const rules = [];
  const rels = ctx.phrases.map((p) => p.replace(/^(?:my|our)\s+/, '')).filter((r) => new RegExp(`^${RELATION}$`, 'i').test(r.replace(/^(?:little|big|older|younger|elder|late|ex-?)\s+/, '')));
  if (rels.length) rules.push({ id: 'operator_personal', reason: 'carried a personal detail from the operator\'s message', re: new RegExp(String.raw`\b(?:${rels.map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\b`, 'i') });
  if (ctx.names.length) rules.push({ id: 'operator_personal', reason: 'carried a personal detail from the operator\'s message', re: new RegExp(String.raw`\b(?:${ctx.names.join('|')})\b`) });
  const circ = ctx.phrases.filter((p) => !/^(?:my|our)\s/.test(p) || !rels.includes(p.replace(/^(?:my|our)\s+/, '')));
  if (circ.length) rules.push({ id: 'operator_personal', reason: 'carried a personal detail from the operator\'s message', re: new RegExp(circ.map((c) => c.replace(/^(?:my|our|i['’]?m|i\s+am|i\s+have|i['’]?ve)\s+/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).map((c) => String.raw`\b${c}\b`).join('|'), 'i') });
  return rules;
}

const PRIVATE_RULES = Object.freeze([
  { id: 'internal_costs', reason: 'gave PG1\'s own costs or margin', re: /\b(?:our|pg1['’]?s|internal|underlying|engine|compute|api)\s+(?:costs?|spend|rates?)\b|\bprovider\s+(?:costs?|spend|rates?)\b|\b(?:unit\s+cost|cost\s+basis|cost\s+price|cogs|gross\s+margin|margins?|mark[- ]?ups?|1\.5\s?x|cost\s+(?:to|for)\s+pg1)\b/i },
  { id: 'config_names', reason: 'named a configuration setting', re: /\b(?:PG1_[A-Z0-9_]+|[A-Z][A-Z0-9]*_(?:API_)?(?:KEY|TOKEN|SECRET|URL)(?:_[A-Z0-9]+)?)\b/ },
  { id: 'internal_ids', reason: 'carried an internal id', re: /\b(?:request\s+id|trace\s*id|req_[a-z0-9]{6,}|experiment\s+[0-9a-f]{8}|film\s+[0-9a-f]{8}|job\s+[0-9a-f]{8})\b/i },
  { id: 'operator_notes', reason: 'was an operator-only note', re: /\b(?:offer\s+check|licence\s+under\s+review|license\s+under\s+review|operator\s+only|note\s+to\s+self|internal\s+note|changed\s+from\s+earlier\s+in\s+this\s+thread|ask\s+pg1\s+why)\b/i }
]);

// { markdown, removed: [{ id, reason, line }] }. A table row or list item
// that carries private context is dropped whole; so is a paragraph line.
// `operatorText`: the operator's own messages, for item 8's personal
// details.
export function scrubPrivateContext(markdown, { operatorText = '' } = {}) {
  const removed = [];
  const rules = [...PRIVATE_RULES, ...personalRules(personalContext(operatorText))];
  const lines = String(markdown || '').split('\n');
  const kept = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) inFence = !inFence;
    const hit = rules.find((r) => r.re.test(line));
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

// { title, markdown, changes: [string] } for a client document:
//   item 7   the title and headings as proposals (unless the operator asked
//            for an agreement), a generic title replaced by the offer's name
//   item 8   private context out, personal details from the operator's own
//            messages (`operatorText`) included
//   item 4   grounding redirect links reduced to their text
//   item 10  provider and model names replaced by PG1 Studio / PG1 Sound
//   offers   lines that offer what PG1 may not are left out
// `changes` is for the operator's chat reply, never for the document.
export function prepareClientDocument({ title = '', markdown = '', request = '', operatorText = '' } = {}) {
  const changes = [];
  const keepAgreement = asksForAgreement(request);
  const offer = offerName(markdown);
  // An agreement title gives way to the offer's own name when the document
  // has one ("Bakery Service Agreement" -> "Bakery video packages proposal").
  const heading = offerHeading(markdown);
  let newTitle = keepAgreement ? String(title || '').trim() : hasAgreementTitle(title) && heading ? `${heading} proposal` : clientTitle(title, { offer });
  if (!keepAgreement && isGenericTitle(newTitle)) newTitle = `${offer} proposal`;
  if (newTitle !== String(title || '').trim()) changes.push(`Titled "${whiteLabel(newTitle)}" rather than "${String(title).trim()}": a client document is a proposal, titled by the offer.`);
  let md = keepAgreement ? String(markdown || '') : clientHeadings(markdown);
  md = stripRedirectLinks(md);
  const scrub = scrubPrivateContext(md, { operatorText: `${request}\n${operatorText}` });
  md = scrub.markdown;
  const reasons = [...new Set(scrub.removed.map((r) => r.reason))];
  if (scrub.removed.length) changes.push(`Left out ${scrub.removed.length} line${scrub.removed.length === 1 ? '' : 's'} that ${reasons.join(', ')}.`);
  if (namesProvider(md) || namesProvider(newTitle)) {
    const count = md.split('\n').filter((l) => namesProvider(l)).length + (namesProvider(newTitle) ? 1 : 0);
    md = whiteLabel(md);
    newTitle = whiteLabel(newTitle);
    changes.push(`Replaced provider and model names on ${count} line${count === 1 ? '' : 's'} with PG1 Studio or PG1 Sound (white label).`);
  }
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

// Whether a client document still names a provider or model (item 10).
export function clientDocumentLeaks(text) {
  const m = PROVIDER_NAME_RE.exec(String(text || ''));
  return m ? m[0] : null;
}
