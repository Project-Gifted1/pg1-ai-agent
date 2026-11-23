// Don't chase correct behaviour. Before PG1 proposes a "fix" for errors it
// returns to callers (method_not_found, invalid params, 4xx), it checks
// whether the error is the correct answer under the relevant spec, and if
// so reports "correct behaviour, no change" with the source. The exception:
// a method that is a real, adopted spec method PG1 should support, which
// becomes a proposal to support it.
//
// 23 Nov: lab 82aaad40 tried to "improve" 11 method_not_found answers to
// server/discover. Under JSON-RPC 2.0 an unknown method gets -32601, but
// server/discover is not unknown: the MCP 2026-07-28 revision says servers
// MUST implement it (PG1 serves 2025-06-18), so the right change is to
// answer it, not to reword the error.
//
//   specVerdict({ type, method, endpoint, status, implemented })
//     -> { correct: true, reason, source } |
//        { correct: false, adopt: { method, spec, source, change } } |
//        { correct: null, reason }                    (no spec applies: look into it)

export const SOURCES = Object.freeze({
  jsonrpc: 'JSON-RPC 2.0, §5.1 Error object (https://www.jsonrpc.org/specification#error_object)',
  mcp: 'Model Context Protocol, 2026-07-28 (https://modelcontextprotocol.io/specification/2026-07-28)',
  mcpDiscover: 'Model Context Protocol 2026-07-28, Discovery: "Servers MUST implement server/discover" (https://modelcontextprotocol.io/specification/2026-07-28/server/discover)',
  a2a: 'A2A Protocol 1.0, JSON-RPC methods (https://a2a-protocol.org/latest/specification/)',
  x402: 'x402: an unpaid request to a paid resource is answered 402 Payment Required with the payment requirements (https://x402.org)',
  http: 'HTTP semantics, RFC 9110 §15.5 (4xx client errors) (https://www.rfc-editor.org/rfc/rfc9110#section-15.5)'
});

// Methods the specs PG1 speaks define (MCP server-side requests and A2A 1.0).
export const MCP_METHODS = Object.freeze(['initialize', 'ping', 'server/discover', 'tools/list', 'tools/call', 'resources/list', 'resources/templates/list', 'resources/read', 'resources/subscribe', 'resources/unsubscribe', 'prompts/list', 'prompts/get', 'completion/complete', 'logging/setLevel']);
export const A2A_METHODS = Object.freeze(['message/send', 'message/stream', 'tasks/get', 'tasks/cancel', 'tasks/resubscribe', 'tasks/pushNotificationConfig/set', 'tasks/pushNotificationConfig/get', 'tasks/pushNotificationConfig/list', 'tasks/pushNotificationConfig/delete', 'agent/getAuthenticatedExtendedCard']);
// Adopted spec methods PG1 should support when a caller asks and it does not.
export const ADOPT = Object.freeze({
  'server/discover': { spec: 'MCP 2026-07-28', source: SOURCES.mcpDiscover, change: 'answer server/discover on /api/mcp with supportedVersions (the versions PG1 serves), capabilities, serverInfo in _meta, resultType "complete", ttlMs and cacheScope, so a 2026-07-28 client can see which version to use' }
});

const clean = (m) => String(m || '').replace(/^\(|\)$/g, '').trim();

export function specVerdict({ type, method = null, endpoint = '/api/mcp', status = null, implemented = [] } = {}) {
  const t = String(type || '').toLowerCase();
  const m = clean(method);
  if (t === 'method_not_found' || t === 'unknown_method') {
    if (m && Object.hasOwn(ADOPT, m) && !implemented.includes(m)) return { correct: false, method: m, adopt: { method: m, ...ADOPT[m] }, reason: `${m} is a real, adopted spec method (${ADOPT[m].spec}) that PG1 does not answer yet` };
    const known = endpoint === '/api/a2a' ? A2A_METHODS : MCP_METHODS;
    if (m && known.includes(m)) return { correct: null, method: m, reason: `${m} is a ${endpoint === '/api/a2a' ? 'A2A 1.0' : 'MCP'} method: check why PG1 does not answer it` };
    return { correct: true, method: m || null, reason: `${m ? `"${m}" is not a method PG1 or the ${endpoint === '/api/a2a' ? 'A2A 1.0' : 'MCP'} spec defines` : 'the method is not one PG1 defines'}, so -32601 Method not found is the correct answer`, source: SOURCES.jsonrpc };
  }
  if (t === 'invalid_params' || t === 'invalid_input') return { correct: true, method: m || null, reason: 'the caller sent parameters the method does not accept, so -32602 Invalid params (with the field that is wrong) is the correct answer; only the message can be clearer', source: SOURCES.jsonrpc, messageOnly: true };
  if (t === 'unknown_tool') return { correct: true, method: m || null, reason: 'the tool is not one PG1 lists in tools/list, so an error naming the unknown tool is the correct answer', source: SOURCES.mcp };
  if (t === 'payment_required' || Number(status) === 402) return { correct: true, reason: 'an unpaid call to a paid tool is answered 402 with the payment requirements', source: SOURCES.x402 };
  if (Number(status) >= 400 && Number(status) < 500) return { correct: true, reason: `${status} is a client error: the request itself was wrong`, source: SOURCES.http };
  return { correct: null, reason: 'no spec decides this one: look into it' };
}

// The report line for a verdict ("correct behaviour, no change (source)").
export function verdictLine(v, { count = null, label = '' } = {}) {
  const what = `${label || v.method || 'these errors'}${count != null ? ` (${count})` : ''}`;
  if (v.correct === true) return `${what}: correct behaviour, no change. ${v.reason}. Source: ${v.source}`;
  if (v.correct === false && v.adopt) return `${what}: not an error to reword. ${v.reason}: support it (${v.adopt.change}). Source: ${v.adopt.source}`;
  return `${what}: ${v.reason}`;
}
