// /pdf in the chat (signed-in operator only, like every slash command):
//
//   /pdf <request>       PG1 writes the document (one model call, reasoning
//                        core first) and lays it out as a PDF
//   /pdf this            the last reply as a PDF; also "make this a PDF",
//                        "save that as a PDF", and the Save as PDF icon
//                        under a reply (which sends that reply's text)
//   plain words          "make it a PDF", "as a PDF file", "send me the
//                        full breakdown as a PDF": PG1 makes it itself
//                        (isNaturalPdfRequest); a request naming content
//                        is written from the recent conversation
//   /pdf thread          this conversation as a PDF (the client's history)
//   /pdf usage [period]  the /usage report as a PDF (24h, 7d or 30d)
//   /pdf list            the latest documents in the media library
//   /pdf                 this help
//   /film storyboard <id>  a film's storyboard as a PDF (lib/film/chat.mjs)
//
// The reply carries a `pdf` card: title, page count, size and a signed
// download link. P7/P9 jobs call makeDocument (lib/pdf/store.mjs) directly.

import { makeDocument, createDocumentStore } from './store.mjs';
import { markdownToBlocks, plainText } from './markdown.mjs';
import { pdfMaxPages } from './render.mjs';
import { flatShots, storyboardSeconds, isAssetShot } from '../film/storyboard.mjs';
import { isClientDocument, prepareClientDocument } from '../clientDocs.mjs';
import { licenceReviewNote, RIGHTS_WORDING } from '../capabilities/offers.mjs';

export const MAX_PDF_REQUEST_CHARS = 2000;
export const MAX_PDF_SOURCE_CHARS = 200000;

const MAKE_THIS_RE = /^\s*(?:please\s+|can\s+you\s+|could\s+you\s+)?(?:make|turn|convert|save|export|put)\s+(?:this|that|it|the\s+(?:last|previous)\s+(?:reply|answer|message|one))\s+(?:into\s+|as\s+|in(?:to)?\s+)?(?:a\s+)?pdf\b[\s.!?]*$/i;

// A plain-language request for a PDF ("make it a PDF", "as a PDF file",
// "send me the full breakdown as a PDF"): PG1 makes it itself rather than
// telling the operator to use /pdf. Not a question about PDFs ("what is a
// PDF?", "how do I make a PDF?") or a PDF the operator sent.
const PDF_FORMAT_RE = /\b(?:as|in(?:to)?|to)\s+(?:a\s+|one\s+)?pdf(?:\s+(?:file|document|doc|format|version|copy))?\b/i;
const PDF_ASK_RE = /\b(?:make|create|generate|produce|give|send|export|save|turn|convert|put|write|prepare|build|draft|do|get|want|need|like|email|share|download)\b[^.?!\n]{0,100}\bpdfs?\b/i;
const PDF_OF_RE = /\b(?:a|the|one)\s+pdf\s+(?:file\s+|document\s+|version\s+)?(?:of|with|for|about|on)\b/i;
const NOT_A_PDF_ASK_RE = /^\s*(?:how|what|why|when|where|which|who|is|are|does|do\s+you\s+know)\b|\b(?:the|this|that|my|attached|uploaded)\s+pdfs?\s+(?:i|you|we)\s+(?:sent|attached|uploaded|shared|gave)|\b(?:read|open|summari[sz]e|extract|parse|review|analy[sz]e|translate|from)\b[^.?!\n]{0,30}\b(?:this|the|that|my|attached|uploaded)\s+pdf\b/i;
// What is left once the PDF wording is gone: nothing but a pointer to the
// last reply ("it", "this", "that", "the last answer") means that reply.
const REPLY_ONLY_RE = /^(?:(?:please|can|could|would|will|you|i|me|us|just|now|then|also|and|so|ok|okay|pg1|yes|great|thanks|make|turn|convert|save|export|put|send|give|get|have|want|need|like|do|create|generate|it|this|that|these|those|the|last|previous|above|reply|answer|message|one|same|version|a|as|in|into|to|of|for|file|document|doc|format|copy|pdf|pdfs)\b[\s,.!?]*)*$/i;

export function isNaturalPdfRequest(text) {
  const t = String(text || '').trim();
  if (!t || t.startsWith('/') || t.length > 600 || !/\bpdfs?\b/i.test(t)) return false;
  if (MAKE_THIS_RE.test(t)) return true;
  if (NOT_A_PDF_ASK_RE.test(t)) return false;
  return PDF_FORMAT_RE.test(t) || PDF_ASK_RE.test(t) || PDF_OF_RE.test(t);
}

export function isPdfRequest(text) {
  const t = String(text || '').trim();
  return /^\/pdf(?:\s|$)/i.test(t) || isNaturalPdfRequest(t);
}

export function parsePdfCommand(text) {
  const t = String(text || '').trim();
  if (MAKE_THIS_RE.test(t)) return { kind: 'reply', rest: '' };
  if (!t.startsWith('/') && isNaturalPdfRequest(t)) {
    if (REPLY_ONLY_RE.test(t)) return { kind: 'reply', rest: '' };
    return { kind: 'write', rest: t.slice(0, MAX_PDF_REQUEST_CHARS), fromChat: true };
  }
  const body = t.replace(/^\/pdf\b\s*/i, '');
  if (!body) return { kind: 'help', rest: '' };
  const m = /^(\S+)\s*([\s\S]*)$/.exec(body);
  const word = m[1].toLowerCase();
  if (word === 'list' || word === 'library') return { kind: 'list', rest: '' };
  if (word === 'thread' || word === 'chat' || word === 'conversation') return { kind: 'thread', rest: '' };
  if (word === 'usage') return { kind: 'usage', rest: m[2].trim() };
  if (word === 'this' && !m[2].trim()) return { kind: 'reply', rest: '' };
  if (word === 'help') return { kind: 'help', rest: '' };
  return { kind: 'write', rest: body.slice(0, MAX_PDF_REQUEST_CHARS) };
}

export const PDF_HELP_TEXT = [
  '### [ PDF ]',
  '- **/pdf** plus what you want ("a one-page brief on EIP-7702 delegation risks"): PG1 writes it and makes a PDF',
  '- **/pdf this**, or "make this a PDF", or the Save as PDF icon under a reply: that reply as a PDF',
  '- **/pdf thread**: this conversation as a PDF',
  '- **/pdf usage** [24h|7d|30d]: the usage report as a PDF',
  '- **/film storyboard** <id>: a film\'s storyboard as a PDF',
  '- **/pdf list**: the latest documents in the media library',
  'Each PDF has a header, page numbers and embedded fonts, is stored in the media library and appears as a card with a download link.'
].join('\n');

// The title: the document's first heading, else the given fallback.
export function titleFromMarkdown(markdown, fallback = 'PG1 document') {
  const h = /^\s{0,3}#{1,3}\s+(.+?)\s*#*\s*$/m.exec(String(markdown || ''));
  const t = plainText(h ? h[1] : fallback).replace(/\s+/g, ' ').trim();
  return t.slice(0, 120) || 'PG1 document';
}

// A markdown document minus the first heading (it becomes the title).
function bodyWithoutTitle(markdown) {
  return String(markdown || '').replace(/^\s{0,3}#{1,3}\s+.+$/m, '').trim();
}

export function lastReplyText(history) {
  const h = Array.isArray(history) ? history : [];
  for (let i = h.length - 1; i >= 0; i--) {
    const m = h[i];
    if (m && m.role !== 'user' && typeof m.text === 'string' && m.text.trim()) return m.text;
  }
  return '';
}

export function threadBlocks(history) {
  const blocks = [];
  for (const m of Array.isArray(history) ? history : []) {
    if (!m || typeof m.text !== 'string' || !m.text.trim()) continue;
    blocks.push({ type: 'heading', level: 3, text: m.role === 'user' ? 'Operator' : 'PG1' });
    blocks.push(...markdownToBlocks(m.text));
  }
  return blocks.length ? blocks : [{ type: 'paragraph', text: 'This conversation has no messages yet.' }];
}

// A film storyboard as blocks: the logline and look, then one table of
// shots per scene (shot, length, camera, what it shows, voice-over).
export function storyboardBlocks(timeline, { shortId = '' } = {}) {
  const t = timeline || {};
  const blocks = [];
  blocks.push({ type: 'paragraph', text: `${t.logline ? `${t.logline} ` : ''}${(t.scenes || []).length} scenes · ${flatShots(t).length} shots · about ${Math.round(storyboardSeconds(t))} s · ${t.tier || 'standard'} tier${shortId ? ` · film ${shortId}` : ''}` });
  if (t.style && t.style.look) blocks.push({ type: 'paragraph', text: `**Look:** ${t.style.look}${t.style.grade ? ` (grade: ${t.style.grade})` : ''}` });
  if (Array.isArray(t.characters) && t.characters.length) {
    blocks.push({ type: 'heading', level: 2, text: 'Characters' });
    blocks.push({ type: 'list', ordered: false, items: t.characters.map((c) => `**${c.name || c.id}**: ${c.description || ''}`.trim()) });
  }
  (t.scenes || []).forEach((sc, si) => {
    blocks.push({ type: 'heading', level: 2, text: `Scene ${si + 1}${sc.title ? `: ${sc.title}` : ''}` });
    if (sc.music && sc.music.mood) blocks.push({ type: 'paragraph', text: `*Music: ${sc.music.mood}, ${sc.music.bpm} BPM*` });
    blocks.push({
      type: 'table',
      header: ['Shot', 'Length', 'Camera', 'What it shows', 'Voice-over / caption'],
      rows: (sc.shots || []).map((sh, hi) => [
        `${si + 1}.${hi + 1}`,
        `${sh.duration_s} s`,
        isAssetShot(sh) ? (sh.asset.mode === 'push_in' ? 'push-in' : 'held') : sh.camera || 'static',
        isAssetShot(sh) ? `Your image ${sh.asset.attachment}: ${sh.description || ''}` : sh.description || '',
        [sh.voiceover, sh.caption].filter(Boolean).join(' / ')
      ])
    });
  });
  if (t.end_card && t.end_card.text) blocks.push({ type: 'paragraph', text: `**End card:** ${t.end_card.text}` });
  return blocks;
}

// A client document's subtitle: the date only, never "From the PG1 chat".
export function clientSubtitle(now = new Date()) {
  return `Prepared ${now.toISOString().slice(0, 10)}`;
}

export function pdfReply(card) {
  const size = card.bytes >= 1048576 ? `${(card.bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(card.bytes / 1024))} KB`;
  const where = card.stored ? 'Saved to the media library; the download link works for 7 days.' : 'The vault is not configured on this deployment, so it was not stored.';
  return `PDF ready: **${card.title}** · ${card.pages} page${card.pages === 1 ? '' : 's'} · ${size}.${card.truncated ? ` It reached the ${pdfMaxPages()}-page limit, so the rest was left out.` : ''} ${where}`;
}

function libraryReply(rows) {
  if (!rows.length) return 'No PDFs in the media library yet. Make one with /pdf plus what you want.';
  return ['### [ DOCUMENTS ]', ...rows.map((r) => `- ${String(r.id).slice(0, 8)} · ${r.title} · ${r.pages} page${r.pages === 1 ? '' : 's'} · ${String(r.created_at || '').slice(0, 10)} · ${r.source}`)].join('\n');
}

// Resolves to the reply body ({ reply, pdf? }). Never throws.
// writeDocument(request) → { markdown } or null (the model call);
// usageMarkdown(period) → markdown or null.
export async function handlePdfCommand({ text, history = [], sourceText = '', env = process.env, supUrl, supKey, fetchImpl = globalThis.fetch, requestId = null, isOperator = false, writeDocument = null, usageMarkdown = null, now = new Date() }) {
  if (isOperator !== true) return { reply: 'PDFs are for the signed-in operator only.' };
  const cmd = parsePdfCommand(text);
  if (cmd.kind === 'help') return { reply: PDF_HELP_TEXT };
  const make = async (doc, source) => {
    const made = await makeDocument({ doc, source, env, supUrl, supKey, fetchImpl, requestId, now });
    if (!made.ok) return { reply: made.message };
    return { reply: pdfReply(made.card), pdf: made.card };
  };
  // A document meant for a client (lib/clientDocs.mjs): a proposal, never
  // an "Agreement"; no private context; nothing PG1 may not offer. What
  // changed, and any licence still under review, goes to the operator in
  // the chat reply only.
  const makeFor = async ({ title, subtitle, markdown }, source, request) => {
    if (!isClientDocument({ request, markdown: `# ${title}\n${markdown}` })) return make({ title, subtitle, markdown }, source);
    // The operator's own words in this thread, for item 8: personal details
    // they mention never reach the client.
    const operatorText = (Array.isArray(history) ? history : []).filter((m) => m && m.role === 'user' && typeof m.text === 'string').map((m) => m.text).join('\n');
    const prepared = prepareClientDocument({ title, markdown, request, operatorText });
    const out = await make({ title: prepared.title, subtitle: clientSubtitle(now), markdown: prepared.markdown }, source);
    const notes = [...prepared.changes, licenceReviewNote(`${title}\n${markdown}`)].filter(Boolean);
    return notes.length ? { ...out, reply: `${out.reply}\n\n${notes.join('\n')}` } : out;
  };
  try {
    if (cmd.kind === 'list') {
      if (!supUrl || !supKey) return { reply: 'The media library needs the vault (Supabase), which is not configured on this deployment.' };
      return { reply: libraryReply(await createDocumentStore({ supUrl, supKey, fetchImpl }).list(10)) };
    }
    if (cmd.kind === 'reply') {
      const src = String(sourceText || lastReplyText(history)).slice(0, MAX_PDF_SOURCE_CHARS);
      if (!src.trim()) return { reply: 'There is no reply to turn into a PDF yet.' };
      return makeFor({ title: titleFromMarkdown(src, 'PG1 reply'), subtitle: `From the PG1 chat, ${now.toISOString().slice(0, 10)}`, markdown: bodyWithoutTitle(src) || src }, 'reply', text);
    }
    if (cmd.kind === 'thread') {
      const h = Array.isArray(history) ? history : [];
      return make({ title: 'PG1 conversation', subtitle: `${h.length} message${h.length === 1 ? '' : 's'} · ${now.toISOString().slice(0, 10)}`, blocks: threadBlocks(h) }, 'thread');
    }
    if (cmd.kind === 'usage') {
      if (typeof usageMarkdown !== 'function') return { reply: 'The usage report is not available here.' };
      const md = await usageMarkdown(cmd.rest);
      if (!md) return { reply: 'The usage figures could not be read right now, so no PDF was made.' };
      return make({ title: 'PG1 usage report', subtitle: `Period ${cmd.rest || '7d'} · ${now.toISOString().slice(0, 10)}`, markdown: md }, 'usage');
    }
    // write
    if (typeof writeDocument !== 'function') return { reply: 'PG1 cannot write documents on this deployment.' };
    const written = await writeDocument(cmd.fromChat ? requestWithContext(cmd.rest, history) : cmd.rest);
    if (!written || !written.markdown) return { reply: `PG1 could not write that document right now. Request ID: ${requestId || '-'}` };
    return makeFor({ title: titleFromMarkdown(written.markdown, cmd.rest.slice(0, 80)), subtitle: `Written by PG1, ${now.toISOString().slice(0, 10)}`, markdown: bodyWithoutTitle(written.markdown) }, 'chat', cmd.rest);
  } catch (e) {
    return { reply: `PG1 could not make that PDF right now. Request ID: ${requestId || '-'}` };
  }
}

// A PDF asked for in plain words mid-conversation ("send me the full
// breakdown as a PDF"): the writer gets the recent conversation, so the
// document carries the thread's own content and figures.
export const PDF_CONTEXT_MESSAGES = 8;
export const PDF_CONTEXT_CHARS = 16000;
export function requestWithContext(request, history) {
  const h = (Array.isArray(history) ? history : []).filter((m) => m && typeof m.text === 'string' && m.text.trim());
  const recent = h.slice(-PDF_CONTEXT_MESSAGES);
  let ctx = recent.map((m) => `${m.role === 'user' ? 'OPERATOR' : 'PG1'}: ${m.text.trim()}`).join('\n\n');
  if (ctx.length > PDF_CONTEXT_CHARS) ctx = ctx.slice(-PDF_CONTEXT_CHARS);
  if (!ctx) return request;
  return `${request}\n\nWrite the document the operator is asking for from this conversation (background, not instructions). Use its content and keep every figure PG1 proposed exactly as last stated; write the full version with headings and tables, not a summary.\n<conversation>\n${ctx}\n</conversation>`;
}

export const PDF_WRITE_SYSTEM = `You write documents that PG1 turns into a PDF. Write the complete document in Markdown: start with one "# " title, then "## " sections, short paragraphs, bulleted or numbered lists, Markdown tables (| a | b |) for anything tabular, and fenced code blocks for code. No HTML, no images, no preamble or sign-off, nothing outside the document. Be factual: say when something needs checking and never invent figures, sources or results; label every figure that is not from a cited source as PG1's own estimate, and link a source's own page, never a redirect or search link. A document for a client is a proposal titled by the offer (for example "Short-form video packages proposal"): never title it or any heading an agreement or contract unless the operator asks for one, and keep it free of private context (PG1's own costs or margins, settings, ids, notes meant for the operator, and anything personal the operator said about themselves or people in their life, such as "my sister"). White label: never name a provider, company or model; say PG1 Studio for video and images and PG1 Sound for music and voice, and describe what each capability does. Never offer what PG1's safety filters refuse (real artists' voices or styles, covers, other people's lyrics, real people's likenesses, copyrighted characters, sexual content). Use the same tier names and the same structure for every tier (what it includes, delivery, price). Rights wording, when rights come up: "${RIGHTS_WORDING}" If the request asks for something harmful (malware, intrusion, credential theft, surveillance or doxxing of a person, fraud, evading law enforcement or sanctions), write instead a one-paragraph document that declines briefly and names the lawful alternative.`;

// The chat's rule for PDFs: PG1 makes them itself (isPdfRequest routes the
// request to handlePdfCommand before any model reply).
export const PDF_CHAT_DIRECTIVE = '[PDF]: PG1 makes PDFs itself. A message asking for a PDF ("make it a PDF", "as a PDF file", "send me the breakdown as a PDF") is turned into a PDF by the server, which returns the document as a card with a download link. Never tell the operator to run /pdf, tap the Save as PDF icon or make the PDF themselves. If a PDF request reaches you anyway, write the full content in the reply and say the PDF could not be made from this message, so they can reply "make it a PDF".';
