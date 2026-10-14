// pg1-sdk: a small, dependency-free client for PG1.
//
//   const pg1 = new PG1Client({ payer });          // payer: optional x402 signer
//   const r = await pg1.preflight('pay', '0x...', { chain: 'base' });
//   if (r.result.decision !== 'no_flags') stop();
//   r.verified                                       // { valid, reason, kid }
//
// Every call goes to PG1's MCP endpoint and every result is checked against
// PG1's published Ed25519 keys (/.well-known/pg1-signing-key) unless
// verify: false. Payment: the free tier first; then, when a tool asks for
// payment, the `payer` you supply turns PG1's x402 PaymentRequired into a
// PaymentPayload (for example with @x402/evm and your wallet); the call is
// retried once with it. Without a payer a payment request is returned as
// { paymentRequired }.

export const DEFAULT_BASE_URL = 'https://pg1-ai-agent.vercel.app';
export const SIGNATURE_META = 'pg1/signature';

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromB64u = (s) => {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export async function requestHash(tool, args) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(canonicalJson({ tool: String(tool || ''), arguments: args && typeof args === 'object' ? args : {} }))));
}

function sourcesOf(result) {
  const checks = result && Array.isArray(result.checks) ? result.checks : [];
  return [...new Set(checks.map((c) => c && c.source).filter(Boolean).map(String))];
}

// Verifies a PG1 result against its signature block and a JWKS. Pass tool
// and args to also check that it answers that exact request.
export async function verifyResult({ result, signature, jwks, tool = null, args = null }) {
  if (!signature || typeof signature !== 'object') return { valid: false, reason: 'missing_signature' };
  if (signature.alg !== 'EdDSA') return { valid: false, reason: 'unsupported_alg' };
  const key = (jwks && Array.isArray(jwks.keys) ? jwks.keys : []).find((k) => k && k.kid === signature.kid && k.kty === 'OKP' && k.crv === 'Ed25519');
  if (!key) return { valid: false, reason: 'unknown_key', kid: signature.kid };
  if (tool != null && (await requestHash(tool, args || {})) !== signature.request_hash) return { valid: false, reason: 'request_mismatch', kid: key.kid };
  if (!result || typeof result !== 'object') return { valid: false, reason: 'missing_result', kid: key.kid };
  const { signature: _drop, ...clean } = result;
  if (canonicalJson(sourcesOf(clean)) !== canonicalJson(signature.sources || [])) return { valid: false, reason: 'sources_mismatch', kid: key.kid };
  const payload = canonicalJson({ request_hash: signature.request_hash, result: clean, sources: signature.sources, timestamp: signature.timestamp, version: signature.version });
  try {
    const pub = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: key.x }, { name: 'Ed25519' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, pub, fromB64u(signature.sig || ''), enc.encode(payload));
    return ok ? { valid: true, reason: 'ok', kid: key.kid } : { valid: false, reason: 'bad_signature', kid: key.kid };
  } catch (e) {
    return { valid: false, reason: 'bad_signature', kid: key.kid };
  }
}

// Checks a watchlist webhook's X-PG1-Signature header.
export async function verifyWebhook(secret, body, header, { toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(header || ''));
  if (!m || Math.abs(nowSec - Number(m[1])) > toleranceSec) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${m[1]}.${body}`)));
  let diff = expected.length ^ m[2].length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ m[2].charCodeAt(i % m[2].length);
  return diff === 0;
}

export class PG1Error extends Error {
  constructor(message, { code = null, data = null } = {}) {
    super(message);
    this.name = 'PG1Error';
    this.code = code;
    this.data = data;
  }
}

export class PG1Client {
  constructor({ baseUrl = DEFAULT_BASE_URL, apiKey = null, payer = null, fetch: fetchImpl = globalThis.fetch, verify = true, jwksTtlMs = 3600000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.payer = payer;
    this.fetch = fetchImpl;
    this.verify = verify;
    this.jwksTtlMs = jwksTtlMs;
    this._jwks = null;
    this._id = 0;
  }

  async jwks({ refresh = false } = {}) {
    if (!refresh && this._jwks && this._jwks.expires > Date.now()) return this._jwks.value;
    const res = await this.fetch(`${this.baseUrl}/.well-known/pg1-signing-key`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new PG1Error(`could not read PG1's signing keys (${res.status})`, { code: 'jwks_unavailable' });
    const value = await res.json();
    this._jwks = { value, expires: Date.now() + this.jwksTtlMs };
    return value;
  }

  async _rpc(method, params) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    const res = await this.fetch(`${this.baseUrl}/api/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++this._id, method, params }) });
    const body = await res.json().catch(() => null);
    if (!body) throw new PG1Error(`PG1 returned HTTP ${res.status} with no JSON`, { code: 'bad_response' });
    if (body.error) throw new PG1Error(body.error.message, { code: body.error.code, data: body.error.data });
    return body.result;
  }

  async listTools() {
    return (await this._rpc('tools/list', {})).tools;
  }

  // Calls any PG1 tool. Returns { result, signature, verified, paid } or
  // { paymentRequired } when payment is needed and no payer is set.
  async call(name, args = {}, { payment = null } = {}) {
    const params = { name, arguments: args, ...(payment ? { _meta: { 'x402/payment': payment } } : {}) };
    const r = await this._rpc('tools/call', params);
    const text = r && Array.isArray(r.content) && r.content[0] && r.content[0].text;
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = null; }
    if (r && r.isError) {
      const pr = r.structuredContent && r.structuredContent.accepts ? r.structuredContent : parsed && parsed.accepts ? parsed : null;
      if (pr) {
        if (payment || !this.payer) return { paymentRequired: pr };
        return this.call(name, args, { payment: await this.payer(pr, { tool: name, args }) });
      }
      throw new PG1Error((parsed && (parsed.error || parsed.message)) || String(text || 'tool error'), { code: parsed && parsed.code, data: parsed });
    }
    const signature = (r && r._meta && r._meta[SIGNATURE_META]) || null;
    const out = { result: parsed, signature, paid: !!payment, verified: null };
    if (this.verify) {
      out.verified = signature ? await verifyResult({ result: parsed, signature, jwks: await this.jwks(), tool: name, args }) : { valid: false, reason: 'missing_signature' };
    }
    return out;
  }

  // One call before you act: action is pay | open | install | patch | trust_agent.
  preflight(action, target, { chain, ecosystem, ...rest } = {}) {
    return this.call('preflight_check', { action, target, ...(chain ? { chain } : {}), ...(ecosystem ? { ecosystem } : {}) }, rest);
  }

  checkWalletSanctions(address) { return this.call('check_wallet_sanctions', { address }); }
  checkWalletAge(address, chain = 'base') { return this.call('check_wallet_age', { address, chain }); }
  checkDomainAge(domain) { return this.call('check_domain_age', { domain }); }
  checkHostnameReputation(hostname) { return this.call('check_hostname_reputation', { hostname }); }
  checkPackage(ecosystem, name, version) { return this.call('check_package', { ecosystem, name, ...(version ? { version } : {}) }); }
  checkX402Endpoint(url) { return this.call('check_x402_endpoint', { url }); }
  checkAgentCard(urlOrDomain) { return this.call('check_agent_card', /^https:\/\//i.test(urlOrDomain) ? { url: urlOrDomain } : { domain: urlOrDomain }); }
  getCveDetails(cveId) { return this.call('get_cve_details', { cve_id: cveId }); }
  getCveByProduct(product, { vendor, version } = {}) { return this.call('get_cve_by_product', { product, ...(vendor ? { vendor } : {}), ...(version ? { version } : {}) }); }
  getThreatActorProfile(name) { return this.call('get_threat_actor_profile', { name }); }
  getUsageStatus() { return this.call('get_usage_status', {}); }
}
