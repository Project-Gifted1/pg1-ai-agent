// PG1 Studio: images attached to a /film (or /film edit) message, used as
// fixed brand assets (a logo end card, a product shot) placed in the film
// exactly as they are.
//
// Capture (lib/film/chat.mjs). Each image is checked (PNG, JPEG or WebP by
// its bytes, not only its declared type; at most MAX_FILM_ATTACHMENT_BYTES;
// at most MAX_FILM_ATTACHMENTS per message), stored in the vault (pg1-vault,
// the same private bucket and signed links as every other film file) under
// films/<id>/attachments/, and recorded as a pg1_film_assets row of kind
// 'reference' with meta { source: 'attachment', index, ... }. Anything else
// attached is refused with a plain reason, before anything is created or
// spent.
//
// Storyboard (lib/film/pipeline.mjs runStoryboard). The storyboard model is
// told which images exist (index, size, the operator's words about them)
// and may place one as a shot: shot.asset = { attachment: n, mode: 'hold' |
// 'push_in' }. When the request asks for an image to be used as it is, a
// shot that shows it is guaranteed (placeAttachments,
// lib/film/storyboard.mjs).
//
// Render. Such a shot never goes to an image or video engine: ffmpeg places
// the original image (lib/film/ffmpeg.mjs segmentFromImage), letterboxed
// into the frame, with the film's colour grade off, and its frames are
// checked against the source image instead of the generated-shot check.
//
// Everything the operator reads calls it "Your image" (YOUR_IMAGE_LABEL).

import crypto from 'node:crypto';
import { IMAGE_MIME_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE, normalizeImageMime, base64ByteLength } from '../visionInput.mjs';
import { filmPath } from './store.mjs';

export const YOUR_IMAGE_LABEL = 'Your image';
export const FILM_ATTACHMENT_TYPES = IMAGE_MIME_TYPES;
export const MAX_FILM_ATTACHMENT_BYTES = MAX_IMAGE_BYTES;
export const MAX_FILM_ATTACHMENTS = MAX_IMAGES_PER_MESSAGE;
// Images a film may hold in all, across /film and its edits.
export const MAX_FILM_ATTACHMENTS_TOTAL = 8;
export const MIN_ATTACHMENT_EDGE_PX = 16;
export const MAX_ATTACHMENT_EDGE_PX = 8192;
export const ATTACHMENT_MODES = Object.freeze(['hold', 'push_in']);
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export function yourImageLabel(index) {
  return `${YOUR_IMAGE_LABEL} ${index}`;
}

// --- reading an image's header -----------------------------------------------------

function pngInfo(b) {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a || b.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { mime: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function jpegInfo(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { mime: 'image/jpeg', width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function webpInfo(b) {
  if (b.length < 30 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { mime: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L' && b[20] === 0x2f) {
    const bits = b.readUInt32LE(21);
    return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    // Flag 0x02: an animation, which is not a still to place.
    return { mime: 'image/webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3), ...(b[20] & 0x02 ? { animated: true } : {}) };
  }
  return null;
}

// { mime, width, height } from the image's own bytes, or null when they
// are not a PNG, JPEG or WebP whose size can be read.
export function sniffImage(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  try {
    return pngInfo(b) || jpegInfo(b) || webpInfo(b);
  } catch (e) {
    return null;
  }
}

// --- checking what was attached ------------------------------------------------------

const TYPES_TEXT = 'PNG, JPEG or WebP';

function refuse(message) {
  return { ok: false, images: [], message: `PG1 Studio could not use the attachment${message.plural ? 's' : ''}: ${message.text} Attach ${TYPES_TEXT} images, up to ${MAX_FILM_ATTACHMENTS} per message and ${Math.round(MAX_FILM_ATTACHMENT_BYTES / 1024 / 1024)} MB each. Nothing was created or spent.` };
}

// The message's attachments (api/chat.mjs payload parts, { inlineData:
// { mimeType, data } } with optional name) checked for a film. Resolves to
// { ok: true, images: [{ n, mime, bytes, width, height, name }] } (n counts
// from 1 in the order attached; [] when nothing was attached), or { ok:
// false, message } naming the first problem.
export function validateFilmAttachments(files) {
  const list = (Array.isArray(files) ? files : []).filter((f) => f && typeof f === 'object');
  if (!list.length) return { ok: true, images: [] };
  if (list.length > MAX_FILM_ATTACHMENTS) return refuse({ plural: true, text: `${list.length} files were attached and a film takes at most ${MAX_FILM_ATTACHMENTS} per message.` });
  const images = [];
  for (const [i, f] of list.entries()) {
    const n = i + 1;
    const name = typeof f.name === 'string' && f.name ? `"${f.name.slice(0, 60)}"` : `attachment ${n}`;
    const inline = f.inlineData && typeof f.inlineData === 'object' ? f.inlineData : null;
    if (!inline || typeof inline.data !== 'string' || !inline.data) return refuse({ text: `${name} is empty.` });
    const declared = normalizeImageMime(inline.mimeType);
    if (!FILM_ATTACHMENT_TYPES.includes(declared)) return refuse({ text: `${name} is ${declared ? `a ${declared} file` : 'not an image'}, not a ${TYPES_TEXT} image.` });
    if (base64ByteLength(inline.data) > MAX_FILM_ATTACHMENT_BYTES) return refuse({ text: `${name} is larger than ${Math.round(MAX_FILM_ATTACHMENT_BYTES / 1024 / 1024)} MB.` });
    const bytes = Buffer.from(inline.data, 'base64');
    const info = sniffImage(bytes);
    if (!info) return refuse({ text: `${name} is not a readable ${TYPES_TEXT} image.` });
    if (info.animated) return refuse({ text: `${name} is an animated image; attach a still.` });
    if (info.width < MIN_ATTACHMENT_EDGE_PX || info.height < MIN_ATTACHMENT_EDGE_PX || info.width > MAX_ATTACHMENT_EDGE_PX || info.height > MAX_ATTACHMENT_EDGE_PX) {
      return refuse({ text: `${name} is ${info.width}×${info.height} px; an image must be ${MIN_ATTACHMENT_EDGE_PX} to ${MAX_ATTACHMENT_EDGE_PX} px on each side.` });
    }
    images.push({ n, mime: info.mime, bytes, width: info.width, height: info.height, name: typeof f.name === 'string' ? f.name.slice(0, 120) : null });
  }
  return { ok: true, images };
}

// --- the operator's words about the images -------------------------------------------

const IMAGE_WORDS = /\b(?:attach\w*|image|images|picture|pictures|photo|photos|logo|logos|png|jpe?g|webp|end\s*card|endcard|brand\w*|screenshot|graphic|artwork|poster)\b/i;
const UNALTERED_RE = /\b(?:unaltered|unchanged|untouched|unmodified|as[\s-]is|exactly\s+as|just\s+as\s+(?:it\s+is|attached)|without\s+(?:any\s+)?(?:changes?|chang\w+|alter\w*|modif\w*|edit\w*|touch\w*)|(?:don'?t|do\s+not|never)\s+(?:change|alter|modify|edit|touch|regenerate|redraw|recreate)|original\s+(?:image|logo|file|artwork)|the\s+real\s+logo|my\s+(?:actual|exact)\s+logo)\b/i;
const END_CARD_RE = /\b(?:end\s*card|endcard|end\s+(?:frame|slate|screen)|closing\s+(?:card|shot|frame)|(?:at|for)\s+the\s+end|to\s+end\s+(?:on|with)|final\s+(?:shot|frame))\b/i;

// The sentences of the request that talk about the attached images (at
// most `max` characters), for the storyboard model.
export function attachmentWording(request, max = 600) {
  const sentences = String(request || '').split(/(?<=[.!?;])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  return sentences.filter((s) => IMAGE_WORDS.test(s) || UNALTERED_RE.test(s)).join(' ').slice(0, max);
}

// Whether the request asks for the attached images to be used as they are.
export function wantsUnaltered(request) {
  return UNALTERED_RE.test(String(request || ''));
}

export function wantsEndCard(request) {
  return END_CARD_RE.test(String(request || ''));
}

// --- storing --------------------------------------------------------------------------

export function isAttachmentAsset(a) {
  return !!(a && a.kind === 'reference' && a.meta && typeof a.meta === 'object' && a.meta.source === 'attachment');
}

// A stored attachment row as the timeline and the storyboard step carry it.
export function attachmentFromAsset(a) {
  const m = a.meta || {};
  return { index: Number(m.index), asset_id: a.id, width: Number(m.width) || 0, height: Number(m.height) || 0, mime: a.mime_type || m.mime || null, note: typeof m.note === 'string' ? m.note : '', exact: m.exact === true, end_card: m.end_card === true };
}

// The film's stored attachments, by index.
export async function listFilmAttachments(store, projectId) {
  const rows = await store.listAssets(projectId, { kinds: ['reference'] });
  return rows.filter(isAttachmentAsset).map(attachmentFromAsset).filter((a) => Number.isInteger(a.index) && a.index > 0).sort((x, y) => x.index - y.index);
}

// Stores checked images (validateFilmAttachments) for a film, numbered on
// from `firstIndex`, and resolves to their timeline entries. A failed
// upload or row throws; what was stored before it stays in the vault.
export async function storeFilmAttachments({ store, projectId, images, request = '', firstIndex = 1, timelineVersion = null }) {
  const note = attachmentWording(request);
  const exact = wantsUnaltered(request);
  const endCard = wantsEndCard(request);
  const out = [];
  for (const [i, img] of images.entries()) {
    const index = firstIndex + i;
    const sha = crypto.createHash('sha256').update(img.bytes).digest('hex');
    const storagePath = await store.upload(filmPath(projectId, 'attachments', `attachment-${index}-${sha.slice(0, 12)}.${EXT[img.mime]}`), img.bytes, img.mime);
    const meta = { source: 'attachment', index, width: img.width, height: img.height, mime: img.mime, bytes: img.bytes.length, sha256: sha, note, exact, end_card: endCard, ...(img.name ? { name: img.name } : {}) };
    const row = await store.insertAsset({
      project_id: projectId, kind: 'reference', timeline_version: timelineVersion, fingerprint: null, status: 'ok',
      prompt: null, description: `${yourImageLabel(index)}${note ? `: ${note.slice(0, 160)}` : ''}`,
      storage_path: storagePath, thumb_path: storagePath, mime_type: img.mime, cost_usd: 0, meta
    });
    out.push(attachmentFromAsset({ ...row, meta, mime_type: img.mime }));
  }
  return out;
}

// One line per image for the reply, e.g. "Your image 1 (1200×400 PNG)".
export function attachmentsText(atts) {
  return atts.map((a) => `${yourImageLabel(a.index)} (${a.width}×${a.height} ${String(a.mime || '').replace('image/', '').toUpperCase()})`).join(', ');
}
