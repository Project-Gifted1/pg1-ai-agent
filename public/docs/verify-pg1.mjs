import crypto from 'node:crypto';
const canon = (v) => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canon)}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`)}}`;
export async function verifyPg1(result, sig, jwksUrl = 'https://pg1-ai-agent.vercel.app/.well-known/pg1-signing-key') {
  const { signature, ...clean } = result;
  const jwk = (await (await fetch(jwksUrl)).json()).keys.find((k) => k.kid === sig.kid);
  if (!jwk || sig.alg !== 'EdDSA') return false;
  const signed = canon({ request_hash: sig.request_hash, result: clean, sources: sig.sources, timestamp: sig.timestamp, version: sig.version });
  const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' });
  return crypto.verify(null, Buffer.from(signed, 'utf8'), key, Buffer.from(sig.sig, 'base64url'));
}
