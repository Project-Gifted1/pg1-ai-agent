// /film sync-secrets: a one-off, operator-only copy of this deployment's own
// env values into the GitHub Actions secrets the PG1 Studio render worker
// reads (.github/workflows/film-render.yml).
//
// Two phases, like every other write: the command only proposes (a
// FILM_SYNC_SECRETS row in pending_actions listing names, never values),
// and nothing reaches GitHub until the operator approves it. The values are
// read from the env at approval time, so pending_actions never holds one.
//
// Rules this file keeps:
//   - Only the names in FILM_SECRET_NAMES are ever written. Anything else in
//     the env (ANTHROPIC_API_KEY included) is never read here.
//   - Only PG1_FILM_GITHUB_TOKEN (fine-grained, this repo only) is used;
//     never GITHUB_TOKEN, GITHUB_OWNER_KEY or any other token.
//   - Each value is encrypted to the repo's public key with a libsodium
//     sealed box before it leaves the function.
//   - No value is ever logged, returned or put in an error: replies and
//     results carry names and outcomes only, and GitHub's response bodies
//     are not read.

import { DEFAULT_FILM_REPO } from './dispatch.mjs';

export const FILM_SECRET_NAMES = Object.freeze([
  'PG1_VIDEO_RENDER_SECRET',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'REPLICATE_API_TOKEN',
  'CARTESIA_API_KEY'
]);
export const FILM_SECRETS_REPO = DEFAULT_FILM_REPO;
export const FILM_SECRETS_TOKEN_NAME = 'PG1_FILM_GITHUB_TOKEN';

export const SECRETS_PERMISSION_TEXT = `The ${FILM_SECRETS_TOKEN_NAME} token does not have the Secrets permission on ${FILM_SECRETS_REPO}. Give the fine-grained token "Secrets: Read and write" on this repository, then run /film sync-secrets again.`;

const API = 'https://api.github.com';

export function filmSecretsToken(env = {}) {
  return String(env[FILM_SECRETS_TOKEN_NAME] || '').replace(/\s+/g, '');
}

function present(env, name) {
  const v = env[name];
  return typeof v === 'string' && v.trim() !== '';
}

// { ready: [names], missing: [names] } over the allowlist only.
export function filmSecretsPlan(env = {}) {
  const ready = [];
  const missing = [];
  for (const name of FILM_SECRET_NAMES) (present(env, name) ? ready : missing).push(name);
  return { ready, missing };
}

export function syncProposalText(env = {}) {
  const { ready, missing } = filmSecretsPlan(env);
  return [
    `Copy ${ready.length} value${ready.length === 1 ? '' : 's'} from this deployment into the GitHub Actions secrets of ${FILM_SECRETS_REPO}, for the render worker. Values are encrypted before they are sent and are never shown.`,
    ...FILM_SECRET_NAMES.map((n) => `- ${n}: ${ready.includes(n) ? 'will be written' : 'skipped (not set here)'}`),
    missing.length === FILM_SECRET_NAMES.length ? 'Nothing is set here, so approving writes nothing.' : 'Approve to write them, or decline to leave GitHub unchanged.'
  ].join('\n');
}

let sodiumPromise = null;
async function sodium() {
  if (!sodiumPromise) {
    sodiumPromise = import('libsodium-wrappers').then(async (m) => {
      const s = m.default || m;
      await s.ready;
      return s;
    });
  }
  return sodiumPromise;
}

// A libsodium sealed box of `value` to the repo's base64 public key, as the
// base64 GitHub expects.
export async function sealForGitHub(value, publicKeyB64) {
  const s = await sodium();
  const key = s.from_base64(publicKeyB64, s.base64_variants.ORIGINAL);
  return s.to_base64(s.crypto_box_seal(s.from_string(value), key), s.base64_variants.ORIGINAL);
}

// Resolves to { ok, results: [{ name, result }], permissionDenied, message }
// where result is 'created' | 'updated' | 'skipped' | 'failed'. Never
// throws; never carries a value.
export async function syncFilmSecrets({ env = {}, fetchImpl = globalThis.fetch } = {}) {
  const token = filmSecretsToken(env);
  const skippedAll = (result) => FILM_SECRET_NAMES.map((name) => ({ name, result }));
  if (!token) return { ok: false, results: skippedAll('skipped'), permissionDenied: false, message: `${FILM_SECRETS_TOKEN_NAME} is not set on this deployment; nothing was written.` };

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'PG1-Studio'
  };
  const base = `${API}/repos/${FILM_SECRETS_REPO}/actions/secrets`;
  const denied = (status) => status === 401 || status === 403 || status === 404;

  let key;
  try {
    const res = await fetchImpl(`${base}/public-key`, { method: 'GET', headers, cache: 'no-store' });
    if (denied(res.status)) return { ok: false, results: skippedAll('skipped'), permissionDenied: true, message: SECRETS_PERMISSION_TEXT };
    if (!res.ok) return { ok: false, results: skippedAll('skipped'), permissionDenied: false, message: `GitHub did not return the repository's public key (HTTP ${res.status}); nothing was written.` };
    const j = await res.json();
    if (!j || typeof j.key !== 'string' || typeof j.key_id !== 'string') throw new Error('bad key');
    key = j;
  } catch (e) {
    return { ok: false, results: skippedAll('skipped'), permissionDenied: false, message: "GitHub's public key could not be read; nothing was written." };
  }

  const results = [];
  let permissionDenied = false;
  for (const name of FILM_SECRET_NAMES) {
    if (!present(env, name)) { results.push({ name, result: 'skipped' }); continue; }
    if (permissionDenied) { results.push({ name, result: 'failed' }); continue; }
    try {
      const encrypted = await sealForGitHub(env[name], key.key);
      const res = await fetchImpl(`${base}/${name}`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ encrypted_value: encrypted, key_id: key.key_id }),
        cache: 'no-store'
      });
      if (res.status === 201) results.push({ name, result: 'created' });
      else if (res.status === 204) results.push({ name, result: 'updated' });
      else {
        if (denied(res.status)) permissionDenied = true;
        results.push({ name, result: 'failed' });
      }
    } catch (e) {
      results.push({ name, result: 'failed' });
    }
  }
  const failed = results.some((r) => r.result === 'failed');
  return { ok: !failed, results, permissionDenied, message: permissionDenied ? SECRETS_PERMISSION_TEXT : '' };
}

export function syncResultText(out) {
  const lines = [`PG1 Studio: GitHub Actions secrets for ${FILM_SECRETS_REPO}`];
  for (const r of out.results) lines.push(`- ${r.name}: ${r.result}`);
  if (out.message) lines.push(out.message);
  return lines.join('\n');
}
