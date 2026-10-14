// PG1 documents: PDFs made by lib/pdf, stored in the vault (pg1-vault,
// documents/<id>.pdf) with one row each in public.pg1_documents, the
// media library's documents shelf. Service role only.
//
// makeDocument renders, checks the storage limit (PG1_STORAGE_MAX_MB),
// uploads, records the row and returns the card the chat shows: title,
// page count, size and a signed download link (7 days). Every document
// has an expiry (PG1_PDF_RETENTION_DAYS, default 90; A2A job outputs are
// given 7) and the daily cleanup deletes the file and the row after it
// (purgeExpiredDocuments).

import crypto from 'node:crypto';
import { renderPdf, pdfMaxPages, PdfTooLargeError } from './render.mjs';
import { storageMaxBytes } from '../music/export.mjs';
import { VIDEO_BUCKET } from '../videoJobs.mjs';

export const DOCUMENT_TABLE = 'pg1_documents';
export const DOCUMENT_FOLDER = 'documents';
export const DOCUMENT_SIGNED_URL_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_DOCUMENT_RETENTION_DAYS = 90;
export const DOCUMENT_SOURCES = Object.freeze(['chat', 'reply', 'thread', 'usage', 'film_storyboard', 'a2a', 'foundry', 'lab']);

export function documentRetentionDays(env = process.env) {
  const n = Number(env.PG1_PDF_RETENTION_DAYS);
  return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : DEFAULT_DOCUMENT_RETENTION_DAYS;
}

function headers(supKey, extra = {}) {
  return { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json', ...extra };
}

async function timed(fetchImpl, url, options, ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(t);
  }
}

export function fileSlug(title) {
  return String(title || 'document').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, 60) || 'document';
}

export function createDocumentStore({ supUrl, supKey, fetchImpl = globalThis.fetch }) {
  if (!supUrl || !supKey) throw new Error('storage is not configured');
  return {
    async upload(path, bytes) {
      const res = await timed(fetchImpl, `${supUrl}/storage/v1/object/${VIDEO_BUCKET}/${path}`, {
        method: 'POST',
        headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/pdf', 'x-upsert': 'true' },
        body: bytes
      }, 60000);
      if (!res.ok) throw new Error(`vault upload failed: ${res.status}`);
    },
    async sign(path, download) {
      const res = await timed(fetchImpl, `${supUrl}/storage/v1/object/sign/${VIDEO_BUCKET}/${path}`, { method: 'POST', headers: headers(supKey), body: JSON.stringify({ expiresIn: DOCUMENT_SIGNED_URL_SECONDS }) }, 10000);
      if (!res.ok) throw new Error(`sign failed: ${res.status}`);
      const body = await res.json();
      const signed = body && (body.signedURL || body.signedUrl);
      if (typeof signed !== 'string' || !signed) throw new Error('sign failed: no link');
      let url = /^https:\/\//i.test(signed) ? signed : signed.startsWith('/storage/v1/') ? `${supUrl}${signed}` : `${supUrl}/storage/v1${signed.startsWith('/') ? '' : '/'}${signed}`;
      if (download) url += `${url.includes('?') ? '&' : '?'}download=${encodeURIComponent(download)}`;
      return url;
    },
    async insert(row) {
      const res = await timed(fetchImpl, `${supUrl}/rest/v1/${DOCUMENT_TABLE}`, { method: 'POST', headers: headers(supKey, { Prefer: 'return=representation' }), body: JSON.stringify(row) }, 10000);
      if (!res.ok) throw new Error(`store document failed: ${res.status}`);
      const rows = await res.json();
      return Array.isArray(rows) ? rows[0] : rows;
    },
    async list(limit = 10) {
      const res = await timed(fetchImpl, `${supUrl}/rest/v1/${DOCUMENT_TABLE}?select=id,title,pages,bytes,source,created_at,expires_at,storage_path&order=created_at.desc&limit=${Math.max(1, Math.min(50, limit))}`, { headers: headers(supKey) }, 10000);
      if (!res.ok) throw new Error(`list documents failed: ${res.status}`);
      const rows = await res.json();
      return Array.isArray(rows) ? rows : [];
    }
  };
}

// Renders and stores one PDF. Resolves to { ok: true, card, bytes } or
// { ok: false, code, message }: code is pdf_too_large, storage_unavailable
// or storage_failed. Never throws.
export async function makeDocument({ doc, source = 'chat', env = process.env, supUrl, supKey, fetchImpl = globalThis.fetch, requestId = null, retentionDays = null, now = new Date() }) {
  let rendered;
  try {
    rendered = await renderPdf(doc, { maxPages: pdfMaxPages(env), maxBytes: storageMaxBytes(env), now });
  } catch (e) {
    if (e instanceof PdfTooLargeError) return { ok: false, code: e.code, message: `${e.message} Ask for a shorter document.` };
    return { ok: false, code: 'render_failed', message: 'PG1 could not lay out that PDF.' };
  }
  const id = crypto.randomUUID();
  const base = { id, shortId: id.slice(0, 8), title: rendered.title, pages: rendered.pages, bytes: rendered.bytes.byteLength, truncated: rendered.truncated, source };
  if (!supUrl || !supKey) return { ok: true, card: { ...base, url: null, stored: false }, bytes: rendered.bytes };
  const store = createDocumentStore({ supUrl, supKey, fetchImpl });
  const path = `${DOCUMENT_FOLDER}/${id}.pdf`;
  const days = retentionDays || documentRetentionDays(env);
  const expires = new Date(now.getTime() + days * 86400000).toISOString();
  try {
    await store.upload(path, rendered.bytes);
    await store.insert({ id, title: rendered.title, pages: rendered.pages, bytes: rendered.bytes.byteLength, source: DOCUMENT_SOURCES.includes(source) ? source : 'chat', storage_path: path, request_id: requestId, expires_at: expires });
    const url = await store.sign(path, `${fileSlug(rendered.title)}.pdf`);
    return { ok: true, card: { ...base, url, stored: true, expiresAt: expires }, bytes: rendered.bytes };
  } catch (e) {
    return { ok: false, code: 'storage_failed', message: `PG1 made the PDF but could not store it right now. Request ID: ${requestId || '-'}` };
  }
}

// The daily cleanup: files and rows past expires_at.
export async function purgeExpiredDocuments({ supUrl, supKey, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  if (!supUrl || !supKey) return { ok: false, skipped: 'not configured' };
  const cutoff = new Date(now).toISOString();
  try {
    const res = await timed(fetchImpl, `${supUrl}/rest/v1/${DOCUMENT_TABLE}?select=id,storage_path&expires_at=lt.${encodeURIComponent(cutoff)}&limit=500`, { headers: headers(supKey) }, 10000);
    if (!res.ok) return { ok: false, status: res.status };
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return { ok: true, deleted: 0 };
    const del = await timed(fetchImpl, `${supUrl}/storage/v1/object/${VIDEO_BUCKET}`, { method: 'DELETE', headers: headers(supKey), body: JSON.stringify({ prefixes: rows.map((r) => r.storage_path).filter(Boolean) }) }, 20000);
    if (!del.ok) return { ok: false, status: del.status };
    const ids = rows.map((r) => r.id).filter((x) => /^[0-9a-f-]{36}$/i.test(x));
    const gone = await timed(fetchImpl, `${supUrl}/rest/v1/${DOCUMENT_TABLE}?id=in.(${ids.join(',')})`, { method: 'DELETE', headers: headers(supKey, { Prefer: 'return=minimal' }) }, 10000);
    return gone.ok ? { ok: true, deleted: ids.length } : { ok: false, status: gone.status };
  } catch (e) {
    return { ok: false, error: 'unreachable' };
  }
}
