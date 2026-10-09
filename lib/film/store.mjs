// PG1 Studio storage: the film rows and the media library in Supabase
// (PostgREST and Storage, service role), the same database and vault
// (pg1-vault) PG1 Motion uses.
//
// Media library. Every still, clip, voice line, music bed, preview and
// final film is a pg1_film_assets row with its prompt, a plain description
// ("drone shot over the harbour at dawn"), scene and shot number, timings,
// fingerprint and storage path (plus a thumbnail), so PG1 can find "the
// drone shot in scene 3" (findFilmMedia) and a re-render can reuse it.

import { VIDEO_BUCKET } from '../videoJobs.mjs';

export const FILM_TABLE = 'pg1_film_projects';
export const ASSET_TABLE = 'pg1_film_assets';
export const FILM_FOLDER = 'films';
export const FILM_SIGNED_URL_SECONDS = 7 * 24 * 60 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function headers(supKey, extra = {}) {
  return { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json', ...extra };
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await fetchImpl(url, { ...(options || {}), signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(id);
  }
}

async function json(res, what) {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what} failed: ${res.status} ${text.slice(0, 160)}`);
  try { return JSON.parse(text); } catch (e) { return null; }
}

export function createFilmStore({ supUrl, supKey, fetchImpl = globalThis.fetch }) {
  if (!supUrl || !supKey) throw new Error('storage is not configured');
  const rest = (path, options = {}, timeoutMs = 10000) => fetchWithTimeout(fetchImpl, `${supUrl}/rest/v1/${path}`, { ...options, headers: headers(supKey, options.headers) }, timeoutMs);

  const store = {
    async createProject({ request, requestId = null, tier = 'standard', capUsd, status = 'storyboard_queued' }) {
      const rows = await json(await rest(FILM_TABLE, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ request: String(request).slice(0, 4000), request_id: requestId, tier, cap_usd: capUsd, status })
      }), 'create film');
      return Array.isArray(rows) ? rows[0] : rows;
    },

    // A full id, or the 8-character short id of one of the latest films.
    async getProject(id) {
      let full = String(id || '').toLowerCase();
      if (!UUID_RE.test(full)) {
        if (!/^[0-9a-f]{8}$/.test(full)) return null;
        const recent = await store.listProjects(200);
        const hit = recent.filter((p) => p.id.startsWith(full));
        if (hit.length !== 1) return null;
        full = hit[0].id;
      }
      const rows = await json(await rest(`${FILM_TABLE}?id=eq.${full}&select=*`), 'read film');
      return Array.isArray(rows) && rows[0] ? rows[0] : null;
    },

    async listProjects(limit = 10) {
      const rows = await json(await rest(`${FILM_TABLE}?select=id,title,status,created_at,spent_usd,cap_usd&order=created_at.desc&limit=${Math.max(1, Math.min(200, limit))}`), 'list films');
      return Array.isArray(rows) ? rows : [];
    },

    // Conditional on the current status when `onlyIfStatus` is given.
    // Resolves to the changed rows ([] when the status had moved on).
    async updateProject(id, patch, { onlyIfStatus = null } = {}) {
      let url = `${FILM_TABLE}?id=eq.${encodeURIComponent(id)}`;
      if (onlyIfStatus && onlyIfStatus.length) url += `&status=in.(${onlyIfStatus.map(encodeURIComponent).join(',')})`;
      const rows = await json(await rest(url, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }) }), 'update film');
      return Array.isArray(rows) ? rows : [];
    },

    // Adds `usd` to the film's spend only if it still fits under the cap.
    async charge(projectId, usd) {
      const rows = await json(await rest('rpc/pg1_film_charge', { method: 'POST', body: JSON.stringify({ p_project: projectId, p_amount: Math.round(Math.max(0, usd) * 100) / 100 }) }), 'charge film');
      const row = Array.isArray(rows) ? rows[0] : rows;
      return { charged: !!(row && row.charged), spentUsd: Number(row && row.spent_usd) || 0, capUsd: Number(row && row.cap_usd) || 0 };
    },

    async insertAsset(row) {
      const rows = await json(await rest(ASSET_TABLE, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) }), 'store asset');
      return Array.isArray(rows) ? rows[0] : rows;
    },

    async updateAsset(id, patch) {
      await json(await rest(`${ASSET_TABLE}?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }), 'update asset');
    },

    async listAssets(projectId, { kinds = null, status = 'ok' } = {}) {
      let url = `${ASSET_TABLE}?project_id=eq.${encodeURIComponent(projectId)}&select=id,created_at,kind,scene,shot,shot_id,timeline_version,fingerprint,attempt,status,prompt,description,storage_path,thumb_path,mime_type,duration_s,start_s,end_s,cost_usd,meta&order=created_at.asc&limit=1000`;
      if (status) url += `&status=eq.${status}`;
      if (kinds && kinds.length) url += `&kind=in.(${kinds.join(',')})`;
      const rows = await json(await rest(url), 'list assets');
      return Array.isArray(rows) ? rows : [];
    },

    // "kind:fingerprint" for every usable stored asset.
    async storedFingerprints(projectId) {
      const rows = await store.listAssets(projectId);
      return new Set(rows.filter((r) => r.fingerprint).map((r) => `${r.kind}:${r.fingerprint}`));
    },

    async upload(path, bytes, mimeType) {
      const res = await fetchWithTimeout(fetchImpl, `${supUrl}/storage/v1/object/${VIDEO_BUCKET}/${path}`, {
        method: 'POST',
        headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': mimeType, 'x-upsert': 'true' },
        body: bytes
      }, 300000);
      if (!res.ok) throw new Error(`vault upload failed: ${res.status}`);
      return path;
    },

    async download(path) {
      const res = await fetchWithTimeout(fetchImpl, `${supUrl}/storage/v1/object/${VIDEO_BUCKET}/${path}`, { headers: { apikey: supKey, Authorization: `Bearer ${supKey}` } }, 300000);
      if (!res.ok) throw new Error(`vault read failed: ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },

    async sign(path, expiresIn = FILM_SIGNED_URL_SECONDS) {
      const res = await fetchWithTimeout(fetchImpl, `${supUrl}/storage/v1/object/sign/${VIDEO_BUCKET}/${path}`, { method: 'POST', headers: headers(supKey), body: JSON.stringify({ expiresIn }) }, 10000);
      const body = await json(res, 'sign');
      const signed = body && (body.signedURL || body.signedUrl);
      if (typeof signed !== 'string' || !signed) throw new Error('sign failed: no link');
      if (/^https:\/\//i.test(signed)) return signed;
      if (signed.startsWith('/storage/v1/')) return `${supUrl}${signed}`;
      return `${supUrl}/storage/v1${signed.startsWith('/') ? '' : '/'}${signed}`;
    },

    // A proposal in the existing approve/decline flow (pending_actions, the
    // same table and columns api/chat.mjs uses for code changes).
    async createPendingAction({ actionType, plan, diffSummary, ttlMinutes = 24 * 60, token = null }) {
      const t = token || globalThis.crypto.randomUUID();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlMinutes * 60000);
      const res = await rest('pending_actions', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify([{ token: t, action_type: actionType, plan, diff_summary: String(diffSummary || '').slice(0, 20000), status: 'pending', created_at: now.toISOString(), expires_at: expiresAt.toISOString() }])
      });
      if (!res.ok) throw new Error(`could not store the proposal: ${res.status}`);
      return { token: t, expiresAt: expiresAt.toISOString() };
    }
  };
  return store;
}

export function filmPath(projectId, kind, name) {
  return `${FILM_FOLDER}/${projectId}/${kind}/${name}`;
}

// --- finding media by description --------------------------------------------------

const KIND_WORDS = [
  ['clip', /\b(?:clip|shot|footage|video\s+clip)s?\b/i],
  ['keyframe', /\b(?:still|keyframe|frame|image|picture|photo)s?\b/i],
  ['music', /\b(?:music|score|track|bed|song)s?\b/i],
  ['voice', /\b(?:voice|voiceover|narration|line)s?\b/i],
  ['final', /\b(?:final|film|movie|full\s+video|export)\b/i],
  ['preview', /\b(?:preview|animatic)\b/i]
];
const STOP = new Set(['the', 'a', 'an', 'in', 'of', 'on', 'at', 'with', 'scene', 'shot', 'and', 'to', 'that', 'this', 'one', 'from', 'for', 'show', 'me', 'find']);

// Ranks a film's assets against a phrase such as "the drone shot in scene
// 3" or "3.2": scene and shot numbers, the kind of media, and the words of
// the description and prompt. Resolves to the best matches, best first.
export function rankFilmMedia(assets, query, { limit = 5 } = {}) {
  const q = String(query || '').toLowerCase();
  const dotted = /\b(\d{1,2})\.(\d{1,2})\b/.exec(q);
  const sceneM = /\bscene\s+(\d{1,2})\b/.exec(q);
  const shotM = /\bshot\s+(\d{1,2})\b/.exec(q);
  const scene = dotted ? Number(dotted[1]) : sceneM ? Number(sceneM[1]) : null;
  const shot = dotted ? Number(dotted[2]) : shotM ? Number(shotM[1]) : null;
  const kinds = KIND_WORDS.filter(([, re]) => re.test(q)).map(([k]) => k);
  const words = q.replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
  const scored = assets.map((a) => {
    let score = 0;
    if (scene != null) score += a.scene === scene ? 4 : -4;
    if (shot != null) score += a.shot === shot ? 3 : -3;
    if (kinds.length) score += kinds.includes(a.kind) ? 2 : 0;
    else if (a.kind === 'clip') score += 1;
    const hay = `${a.description || ''} ${a.prompt || ''}`.toLowerCase();
    for (const w of words) if (hay.includes(w)) score += a.description && a.description.toLowerCase().includes(w) ? 2 : 1;
    return { a, score };
  }).filter((x) => x.score > 0);
  scored.sort((x, y) => y.score - x.score || String(y.a.created_at).localeCompare(String(x.a.created_at)));
  return scored.slice(0, limit).map((x) => x.a);
}
