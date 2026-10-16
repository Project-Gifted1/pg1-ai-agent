// Where large media lives: Cloudflare R2 (lib/storage/r2.mjs), never the
// Supabase vault (pg1-vault, 1 GB on the plan). Large media is every video
// and movie master, preview, 9:16 cut, clip and audio stem, and every music
// master, preview and export:
//
//   films/<id>/{clip,preview,final,social,stems}/...   /film and /movie
//   music/<id>/{master,preview,export,stems}/...        /music
//   videos/<job>.mp4                                     PG1 Motion clips
//
// Small files (stills, frames, thumbnails, posters, voice lines, notes,
// attachments, TTS) stay in the vault.
//
// The stores send large media to R2 whenever it is set up. The entry points
// that make large media (scripts/film-render.mjs, scripts/music-render.mjs,
// lib/videoJobs.mjs startVideoJob) refuse to start, before anything is
// spent, when it is not: largeMediaStorageMissing(env) names what is
// missing. PG1_LARGE_MEDIA_IN_VAULT=1 lets large media fall back to the
// vault instead (local development only).

import { r2Config } from './r2.mjs';

export const LARGE_MEDIA_VAULT_ENV = 'PG1_LARGE_MEDIA_IN_VAULT';
export const R2_SETTING_NAMES = Object.freeze(['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']);

const LARGE_KINDS = Object.freeze({
  films: ['clip', 'preview', 'final', 'social', 'stems'],
  music: ['master', 'preview', 'export', 'stems']
});
const VIDEO_RE = /^videos\/[^/]+\.(mp4|webm|mov)$/i;

// True for a vault path (no "r2:" prefix) that is large media.
export function isLargeMediaPath(p) {
  const s = String(p || '');
  if (VIDEO_RE.test(s)) return true;
  const [folder, id, kind] = s.split('/');
  return !!(id && kind && LARGE_KINDS[folder] && LARGE_KINDS[folder].includes(kind));
}

export function largeMediaInVaultAllowed(env = {}) {
  return ['1', 'true', 'yes', 'on'].includes(String(env[LARGE_MEDIA_VAULT_ENV] || '').trim().toLowerCase());
}

// [] when large media can be stored (R2 is set up, or the vault fallback is
// allowed); else the setting names that are missing.
export function largeMediaStorageMissing(env = {}) {
  if (r2Config(env) || largeMediaInVaultAllowed(env)) return [];
  return [`large-file storage (${R2_SETTING_NAMES.join(', ')})`];
}
