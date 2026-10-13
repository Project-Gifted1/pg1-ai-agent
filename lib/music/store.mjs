// PG1 Sound storage: the track rows and the media library in Supabase
// (PostgREST and Storage, service role), the same database and vault
// (pg1-vault) PG1 Studio uses. Tracks are stored under music/<track id>/.

import { VIDEO_BUCKET } from '../videoJobs.mjs';

export const TRACK_TABLE = 'pg1_music_tracks';
export const MUSIC_ASSET_TABLE = 'pg1_music_assets';
export const MUSIC_FOLDER = 'music';
export const MUSIC_SIGNED_URL_SECONDS = 7 * 24 * 60 * 60;
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

export function musicPath(trackId, kind, name) {
  return `${MUSIC_FOLDER}/${trackId}/${kind}/${name}`;
}

export function createMusicStore({ supUrl, supKey, fetchImpl = globalThis.fetch }) {
  if (!supUrl || !supKey) throw new Error('storage is not configured');
  const rest = (path, options = {}, timeoutMs = 10000) => fetchWithTimeout(fetchImpl, `${supUrl}/rest/v1/${path}`, { ...options, headers: headers(supKey, options.headers) }, timeoutMs);

  const store = {
    async createTrack({ prompt, title, options, requestId = null, capUsd, status = 'preview_queued' }) {
      const rows = await json(await rest(TRACK_TABLE, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ prompt: String(prompt).slice(0, 2000), title, options, request_id: requestId, cap_usd: capUsd, status })
      }), 'create track');
      return Array.isArray(rows) ? rows[0] : rows;
    },

    // A full id, or the 8-character short id of one of the latest tracks.
    async getTrack(id) {
      let full = String(id || '').toLowerCase();
      if (!UUID_RE.test(full)) {
        if (!/^[0-9a-f]{8}$/.test(full)) return null;
        const hit = (await store.listTracks(200)).filter((t) => t.id.startsWith(full));
        if (hit.length !== 1) return null;
        full = hit[0].id;
      }
      const rows = await json(await rest(`${TRACK_TABLE}?id=eq.${full}&select=*`), 'read track');
      return Array.isArray(rows) && rows[0] ? rows[0] : null;
    },

    async listTracks(limit = 10) {
      const rows = await json(await rest(`${TRACK_TABLE}?select=id,title,status,created_at,spent_usd,cap_usd,master_path,stems_path,duration_s,bpm,musical_key,options&order=created_at.desc&limit=${Math.max(1, Math.min(200, limit))}`), 'list tracks');
      return Array.isArray(rows) ? rows : [];
    },

    // Conditional on the current status when `onlyIfStatus` is given.
    // Resolves to the changed rows ([] when the status had moved on).
    async updateTrack(id, patch, { onlyIfStatus = null } = {}) {
      let url = `${TRACK_TABLE}?id=eq.${encodeURIComponent(id)}`;
      if (onlyIfStatus && onlyIfStatus.length) url += `&status=in.(${onlyIfStatus.map(encodeURIComponent).join(',')})`;
      const rows = await json(await rest(url, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }) }), 'update track');
      return Array.isArray(rows) ? rows : [];
    },

    async charge(trackId, usd) {
      const rows = await json(await rest('rpc/pg1_music_charge', { method: 'POST', body: JSON.stringify({ p_track: trackId, p_amount: Math.round(Math.max(0, usd) * 100) / 100 }) }), 'charge track');
      const row = Array.isArray(rows) ? rows[0] : rows;
      return { charged: !!(row && row.charged), spentUsd: Number(row && row.spent_usd) || 0, capUsd: Number(row && row.cap_usd) || 0 };
    },

    async refund(trackId, usd) {
      const amount = Math.round(Math.max(0, usd) * 100) / 100;
      if (!(amount > 0)) return null;
      const rows = await json(await rest('rpc/pg1_music_refund', { method: 'POST', body: JSON.stringify({ p_track: trackId, p_amount: amount }) }), 'refund track');
      const row = Array.isArray(rows) ? rows[0] : rows;
      return { spentUsd: Number(row && row.spent_usd) || 0, capUsd: Number(row && row.cap_usd) || 0 };
    },

    async insertAsset(row) {
      const rows = await json(await rest(MUSIC_ASSET_TABLE, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) }), 'store music asset');
      return Array.isArray(rows) ? rows[0] : rows;
    },

    async updateAssets(trackId, patch, { kinds = null } = {}) {
      let url = `${MUSIC_ASSET_TABLE}?track_id=eq.${encodeURIComponent(trackId)}`;
      if (kinds && kinds.length) url += `&kind=in.(${kinds.join(',')})`;
      await json(await rest(url, { method: 'PATCH', body: JSON.stringify(patch) }), 'update music assets');
    },

    async listAssets(trackId, { kinds = null, status = 'ok' } = {}) {
      let url = `${MUSIC_ASSET_TABLE}?track_id=eq.${encodeURIComponent(trackId)}&select=*&order=created_at.asc&limit=200`;
      if (status) url += `&status=eq.${status}`;
      if (kinds && kinds.length) url += `&kind=in.(${kinds.join(',')})`;
      const rows = await json(await rest(url), 'list music assets');
      return Array.isArray(rows) ? rows : [];
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

    // A signed link; `download` makes the browser save it under that name.
    async sign(path, { expiresIn = MUSIC_SIGNED_URL_SECONDS, download = null } = {}) {
      const res = await fetchWithTimeout(fetchImpl, `${supUrl}/storage/v1/object/sign/${VIDEO_BUCKET}/${path}`, { method: 'POST', headers: headers(supKey), body: JSON.stringify({ expiresIn }) }, 10000);
      const body = await json(res, 'sign');
      const signed = body && (body.signedURL || body.signedUrl);
      if (typeof signed !== 'string' || !signed) throw new Error('sign failed: no link');
      let url = /^https:\/\//i.test(signed) ? signed : signed.startsWith('/storage/v1/') ? `${supUrl}${signed}` : `${supUrl}/storage/v1${signed.startsWith('/') ? '' : '/'}${signed}`;
      if (download) url += `${url.includes('?') ? '&' : '?'}download=${encodeURIComponent(download)}`;
      return url;
    },

    // A proposal in the approve/decline flow (pending_actions, the same
    // table and columns as /film's proposals).
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
    },

    // Closes other still-pending proposals (the preview that was not picked).
    async resolvePendingActions(tokens, status = 'declined') {
      const list = (tokens || []).filter((t) => /^[0-9a-f-]{36}$/i.test(String(t)));
      if (!list.length) return;
      await json(await rest(`pending_actions?token=in.(${list.join(',')})&status=eq.pending`, { method: 'PATCH', body: JSON.stringify({ status, resolved_at: new Date().toISOString() }) }), 'resolve proposals');
    }
  };
  return store;
}
