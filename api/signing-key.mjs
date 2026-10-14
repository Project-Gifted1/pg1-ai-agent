// GET /.well-known/pg1-signing-key: PG1's public result-signing keys as a
// JWKS (RFC 7517; Ed25519 keys as OKP, RFC 8037). The current key first,
// then the previous keys kept for rotation (lib/signing.mjs). Public, free.
// Cached for five minutes (no CDN copy), so a rotated key is visible to
// verifiers within minutes; verifiers should also refetch on an unknown kid.

import { publicJwks } from '../lib/signing.mjs';

export const config = { maxDuration: 5 };

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(405).json({ error: 'method not allowed' });
  }
  res.setHeader('Content-Type', 'application/jwk-set+json');
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).json(publicJwks());
}
