// A request's query string, read with the WHATWG URL parser.
//
// The Vercel Node helpers fill req.query lazily with the legacy url.parse(),
// which logs "[DEP0169] DeprecationWarning: url.parse() behavior is not
// standardized" the first time a handler reads it. queryOf(req) uses
// req.query only when it is a plain value already on the request (the tests,
// a framework that parsed it), never the lazy getter, and otherwise reads
// req.url with new URL(). A repeated key keeps its first value, as the
// single-valued parameters these handlers read expect.

export function queryOf(req) {
  if (!req || typeof req !== 'object') return {};
  const own = Object.getOwnPropertyDescriptor(req, 'query');
  if (own && 'value' in own && own.value && typeof own.value === 'object') return own.value;
  const raw = typeof req.url === 'string' ? req.url : '';
  if (!raw) return {};
  let params;
  try { params = new URL(raw, 'http://localhost').searchParams; } catch (e) { return {}; }
  const out = {};
  for (const [k, v] of params) if (!(k in out)) out[k] = v;
  return out;
}
