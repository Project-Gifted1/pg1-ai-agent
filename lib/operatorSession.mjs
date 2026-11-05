// The operator session for non-chat routes: the same sign-in as api/chat.mjs
// (lib/security/auth.mjs: a live session cookie, else USER_API_KEY /
// USER_API_PASS while no passkey is registered or the recovery switch is
// on), the same durable lockout and the same least-privilege rule. 'operator' only
// ever comes from credentials that match; no credentials, wrong credentials
// or anything else a request says about itself is LEAST_PRIVILEGED_ROLE.
//
// Credentials are read from an `Authorization: Basic` header or from a JSON
// body's `user` / `pass` (the shape api/chat.mjs, api/errors.mjs and
// api/handoffs.mjs take). Never from the query string, which ends up in
// access logs and browser history. Nothing here logs.

import { authenticateOperator } from './security/auth.mjs';
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

// Resolves to { role, isOperator, rateLimited }. A locked-out IP gets
// rateLimited: true and is never the operator by password, even with the
// right credentials, as in api/chat.mjs. opts: { store, env, now, push }
// for tests.
export async function resolveOperatorSession(req, opts = {}) {
  var r = await authenticateOperator(req, credentialsFrom(req), opts);
  return {
    role: r.isOperator ? 'operator' : LEAST_PRIVILEGED_ROLE,
    isOperator: r.isOperator,
    rateLimited: r.rateLimited,
    passwordDisabled: !!r.passwordDisabled,
    session: r.session || null
  };
}
