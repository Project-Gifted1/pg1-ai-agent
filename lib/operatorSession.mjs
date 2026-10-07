// The operator session for non-chat routes: the same USER_API_KEY /
// USER_API_PASS check, the same per-IP lockout and the same least-privilege
// rule as api/chat.mjs, where operator commands are gated. 'operator' only
// ever comes from credentials that match; no credentials, wrong credentials
// or anything else a request says about itself is LEAST_PRIVILEGED_ROLE.
//
// Credentials are read from an `Authorization: Basic` header or from a JSON
// body's `user` / `pass` (the shape api/chat.mjs, api/errors.mjs and
// api/handoffs.mjs take). Never from the query string, which ends up in
// access logs and browser history. Nothing here logs.

import { safeCompare, isAuthRateLimited, recordAuthFailure, resetAuthFailures } from '../api/chat.mjs';
import { getRequestIdentifier } from './freeTier.mjs';
import { LEAST_PRIVILEGED_ROLE } from './chatTools.mjs';

function header(req, name) {
  var headers = req && req.headers;
  if (!headers) return '';
  var value = typeof headers.get === 'function' ? headers.get(name) : headers[name];
  return typeof value === 'string' ? value : '';
}

function credentialsFrom(req) {
  var auth = header(req, 'authorization');
  var basic = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(auth);
  if (basic) {
    var decoded = Buffer.from(basic[1], 'base64').toString('utf-8');
    var sep = decoded.indexOf(':');
    if (sep !== -1) return { user: decoded.slice(0, sep), pass: decoded.slice(sep + 1) };
  }
  var body = req && req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (body && typeof body === 'object') {
    return {
      user: typeof body.user === 'string' ? body.user : '',
      pass: typeof body.pass === 'string' ? body.pass : ''
    };
  }
  return { user: '', pass: '' };
}

// Returns { role, isOperator, rateLimited }. A locked-out IP gets
// rateLimited: true and is never the operator, even with the right
// credentials, as in api/chat.mjs.
export function resolveOperatorSession(req) {
  var ip = getRequestIdentifier({ headers: (req && req.headers) || {}, socket: req && req.socket });
  var guest = { role: LEAST_PRIVILEGED_ROLE, isOperator: false, rateLimited: false };
  if (isAuthRateLimited(ip)) return { ...guest, rateLimited: true };

  var creds = credentialsFrom(req);
  var expectedUser = (process.env.USER_API_KEY || process.env.USER_API_USER || '').trim();
  var expectedPass = (process.env.USER_API_PASS || process.env.USER_API_PASSS || '').trim();
  var isAuthed = !!(
    expectedUser && expectedPass && safeCompare(creds.user, expectedUser) && safeCompare(creds.pass, expectedPass)
  );
  if (creds.user || creds.pass) {
    if (isAuthed) resetAuthFailures(ip);
    else recordAuthFailure(ip);
  }
  return isAuthed ? { role: 'operator', isOperator: true, rateLimited: false } : guest;
}
