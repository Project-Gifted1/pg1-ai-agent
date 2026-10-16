#!/usr/bin/env node
// What takes the space in the vault (pg1-vault), and moving the large media
// in it to Cloudflare R2 (lib/storage/largeMedia.mjs says what large media
// is: video and movie masters, previews, cuts, clips and stems, music
// masters, previews and exports, PG1 Motion clips).
//
//   node scripts/move-large-media-to-r2.mjs            report only (default)
//   node scripts/move-large-media-to-r2.mjs --move     copy each large file
//        to R2 (same key), check the copy (MD5 against R2's ETag), then point
//        every database reference at it ('r2:<path>'); the vault copy stays
//   node scripts/move-large-media-to-r2.mjs --move --delete
//        the same, then delete each vault copy whose references all moved
//
// Settings: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or SUPABASEAPI_KEY),
// R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (optional).
// Run from .github/workflows/storage-move.yml (workflow_dispatch). Prints
// sizes and our own storage paths only, never file contents or keys.

import crypto from 'node:crypto';
import { r2Config, signedHeaders, encodeKey, R2_PREFIX } from '../lib/storage/r2.mjs';
import { isLargeMediaPath } from '../lib/storage/largeMedia.mjs';

export const BUCKET = 'pg1-vault';
const PAGE = 1000;

// Every column that holds a vault path of large media, per table.
export const PATH_COLUMNS = Object.freeze({
  pg1_film_assets: ['storage_path'],
  pg1_film_projects: ['preview_path', 'final_path'],
  pg1_music_assets: ['storage_path'],
  pg1_music_tracks: ['master_path', 'preview_path'],
  pg1_video_jobs: ['storage_path']
});
// JSON columns that may carry paths in their values (the 9:16 cut and stems
// in a film's Director state).
export const JSON_PATH_COLUMNS = Object.freeze({ pg1_film_projects: ['director'] });

// The folder a path is counted under in the report: films/*/final,
// music/*/master, videos, or "(root) .mp3" for a file at the top.
export function folderOf(name) {
  const parts = String(name).split('/');
  if (parts.length >= 3 && ['films', 'music', 'movies'].includes(parts[0])) return `${parts[0]}/*/${parts[2]}`;
  if (parts.length >= 2) return parts[0];
  const ext = (/\.([A-Za-z0-9]+)$/.exec(name) || [])[1];
  return `(root) .${ext ? ext.toLowerCase() : 'none'}`;
}

function sbHeaders(key, extra = {}) {
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

// Every object in the bucket: [{ name, bytes, created_at }], walking folders.
export async function listVault({ supUrl, supKey, fetchImpl = globalThis.fetch, prefix = '' }) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const res = await fetchImpl(`${supUrl}/storage/v1/object/list/${BUCKET}`, {
      method: 'POST',
      headers: sbHeaders(supKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prefix, limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } })
    });
    if (!res.ok) throw new Error(`storage list failed (${res.status})`);
    const page = await res.json();
    if (!Array.isArray(page) || !page.length) break;
    for (const f of page) {
      const name = String((f && f.name) || '');
      if (!name) continue;
      const full = prefix ? `${prefix}/${name}` : name;
      if (f.id == null && !f.metadata) out.push(...await listVault({ supUrl, supKey, fetchImpl, prefix: full }));
      else out.push({ name: full, bytes: Number((f.metadata && f.metadata.size) || 0), created_at: f.created_at || null });
    }
    if (page.length < PAGE) break;
  }
  return out;
}

export function vaultReport(objects, { top = 10 } = {}) {
  const folders = new Map();
  let bytes = 0;
  let largeBytes = 0;
  let largeCount = 0;
  for (const o of objects) {
    bytes += o.bytes;
    const k = folderOf(o.name);
    const f = folders.get(k) || { folder: k, bytes: 0, files: 0, large: isLargeMediaPath(o.name) };
    f.bytes += o.bytes;
    f.files++;
    folders.set(k, f);
    if (isLargeMediaPath(o.name)) { largeBytes += o.bytes; largeCount++; }
  }
  return {
    files: objects.length,
    bytes,
    large_media: { files: largeCount, bytes: largeBytes },
    folders: [...folders.values()].sort((a, b) => b.bytes - a.bytes),
    largest: [...objects].sort((a, b) => b.bytes - a.bytes).slice(0, top)
  };
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

export function formatVaultReport(r) {
  const lines = [`${BUCKET}: ${r.files} files, ${mb(r.bytes)}; large media ${r.large_media.files} files, ${mb(r.large_media.bytes)} (${r.bytes ? ((r.large_media.bytes / r.bytes) * 100).toFixed(1) : '0.0'}%)`, 'By folder:'];
  for (const f of r.folders) lines.push(`  ${f.folder.padEnd(28)} ${mb(f.bytes).padStart(10)}  ${String(f.files).padStart(5)} files${f.large ? '  -> R2' : ''}`);
  lines.push('Largest files:');
  for (const o of r.largest) lines.push(`  ${mb(o.bytes).padStart(10)}  ${o.name}`);
  return lines.join('\n');
}

async function r2Put({ cfg, fetchImpl, key, body, contentType }) {
  const path = `/${encodeURIComponent(cfg.bucket)}/${encodeKey(key)}`;
  const headers = signedHeaders({ host: cfg.host, region: cfg.region, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, method: 'PUT', path, body, contentType });
  const res = await fetchImpl(`https://${cfg.host}${path}`, { method: 'PUT', headers, body });
  if (!res.ok) throw new Error(`R2 upload failed (${res.status})`);
  const etag = String((res.headers && res.headers.get && res.headers.get('etag')) || '').replace(/"/g, '').toLowerCase();
  return etag;
}

async function rewriteReferences({ supUrl, supKey, fetchImpl, from, to }) {
  let changed = 0;
  for (const [table, columns] of Object.entries(PATH_COLUMNS)) {
    for (const col of columns) {
      const res = await fetchImpl(`${supUrl}/rest/v1/${table}?${col}=eq.${encodeURIComponent(from)}`, {
        method: 'PATCH',
        headers: sbHeaders(supKey, { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
        body: JSON.stringify({ [col]: to })
      });
      if (res.status === 404 || res.status === 400) continue; // table or column not there
      if (!res.ok) throw new Error(`update ${table}.${col} failed (${res.status})`);
      const rows = await res.json().catch(() => []);
      changed += Array.isArray(rows) ? rows.length : 0;
    }
  }
  return changed;
}

function replaceDeep(value, from, to) {
  if (value === from) return { value: to, n: 1 };
  if (Array.isArray(value)) {
    let n = 0;
    const out = value.map((v) => { const r = replaceDeep(v, from, to); n += r.n; return r.value; });
    return { value: out, n };
  }
  if (value && typeof value === 'object') {
    let n = 0;
    const out = {};
    for (const [k, v] of Object.entries(value)) { const r = replaceDeep(v, from, to); n += r.n; out[k] = r.value; }
    return { value: out, n };
  }
  return { value, n: 0 };
}

async function rewriteJsonReferences({ supUrl, supKey, fetchImpl, moves }) {
  let changed = 0;
  for (const [table, columns] of Object.entries(JSON_PATH_COLUMNS)) {
    for (const col of columns) {
      const res = await fetchImpl(`${supUrl}/rest/v1/${table}?select=id,${col}&${col}=not.is.null&limit=1000`, { headers: sbHeaders(supKey) });
      if (!res.ok) continue;
      const rows = await res.json().catch(() => []);
      for (const row of Array.isArray(rows) ? rows : []) {
        let value = row[col];
        let n = 0;
        for (const [from, to] of moves) { const r = replaceDeep(value, from, to); value = r.value; n += r.n; }
        if (!n) continue;
        const up = await fetchImpl(`${supUrl}/rest/v1/${table}?id=eq.${encodeURIComponent(row.id)}`, { method: 'PATCH', headers: sbHeaders(supKey, { 'Content-Type': 'application/json' }), body: JSON.stringify({ [col]: value }) });
        if (!up.ok) throw new Error(`update ${table}.${col} failed (${up.status})`);
        changed += n;
      }
    }
  }
  return changed;
}

// Copies every large file to R2 and repoints its references. Resolves to
// { moved: [{ name, bytes, refs }], failed: [{ name, reason }], deleted }.
export async function moveLargeMedia({ supUrl, supKey, r2, fetchImpl = globalThis.fetch, objects, del = false, log = () => {} }) {
  const moved = [];
  const failed = [];
  for (const o of objects.filter((x) => isLargeMediaPath(x.name))) {
    try {
      const got = await fetchImpl(`${supUrl}/storage/v1/object/${BUCKET}/${o.name}`, { headers: sbHeaders(supKey) });
      if (!got.ok) throw new Error(`vault read failed (${got.status})`);
      const body = Buffer.from(await got.arrayBuffer());
      const md5 = crypto.createHash('md5').update(body).digest('hex');
      const etag = await r2Put({ cfg: r2, fetchImpl, key: o.name, body, contentType: (got.headers && got.headers.get && got.headers.get('content-type')) || 'application/octet-stream' });
      if (etag && etag !== md5) throw new Error('R2 copy does not match (MD5)');
      const refs = await rewriteReferences({ supUrl, supKey, fetchImpl, from: o.name, to: `${R2_PREFIX}${o.name}` });
      moved.push({ name: o.name, bytes: body.length, refs });
      log(`moved ${o.name} (${mb(body.length)}, ${refs} reference${refs === 1 ? '' : 's'})`);
    } catch (e) {
      failed.push({ name: o.name, reason: e.message });
      log(`FAILED ${o.name}: ${e.message}`);
    }
  }
  const jsonRefs = moved.length ? await rewriteJsonReferences({ supUrl, supKey, fetchImpl, moves: moved.map((m) => [m.name, `${R2_PREFIX}${m.name}`]) }) : 0;
  let deleted = 0;
  if (del && moved.length) {
    for (let i = 0; i < moved.length; i += 100) {
      const names = moved.slice(i, i + 100).map((m) => m.name);
      const res = await fetchImpl(`${supUrl}/storage/v1/object/${BUCKET}`, { method: 'DELETE', headers: sbHeaders(supKey, { 'Content-Type': 'application/json' }), body: JSON.stringify({ prefixes: names }) });
      if (res.ok) deleted += names.length;
      else log(`delete failed (${res.status}) for ${names.length} files; they stay in the vault`);
    }
  }
  return { moved, failed, json_refs: jsonRefs, deleted };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const supUrl = (process.env.SUPABASE_URL || '').replace(/\s+/g, '').replace(/\/+$/, '');
  const supKey = (process.env.SUPABASEAPI_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').replace(/\s+/g, '');
  const args = new Set(process.argv.slice(2));
  (async () => {
    if (!supUrl || !supKey) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
    const objects = await listVault({ supUrl, supKey });
    console.log(formatVaultReport(vaultReport(objects)));
    if (!args.has('--move')) return;
    const r2 = r2Config(process.env);
    if (!r2) throw new Error('R2 is not set up (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY).');
    const out = await moveLargeMedia({ supUrl, supKey, r2, objects, del: args.has('--delete'), log: console.log });
    console.log(`moved ${out.moved.length} files (${mb(out.moved.reduce((n, m) => n + m.bytes, 0))}), ${out.failed.length} failed, ${out.json_refs} JSON references updated, ${out.deleted} vault copies deleted`);
    if (out.failed.length) process.exitCode = 1;
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
