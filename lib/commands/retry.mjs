// FAILURE -> RETRY: a search, research, mission, film, movie, music, lab
// dispatch or tool call that fails for a transient reason (429, a timeout,
// a 5xx, a dropped connection) is tried once more after a short back-off.
// A second failure is final: the caller shows the failure card (Retry, Fix
// it, Dismiss; public/index.html) with the plain reason. Nothing else is
// retried: a 4xx, a refusal, out of credit or a spending cap would only
// fail again.

export const RETRY_BACKOFF_MS = 1500;

// Under Node's test runner the back-off is instant unless a test passes its
// own sleep (the same convention as lib/aiRouter.mjs throttleSleep).
const defaultSleep = (ms) => (process.env.NODE_TEST_CONTEXT ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));

const TRANSIENT_TEXT_RE = /timed? ?out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network|fetch failed|temporarily unavailable|overloaded|upstream_unavailable/i;
const FINAL_TEXT_RE = /credit|billing|spending cap|spend cap|quota exceeded for metric .*per ?day|insufficient_quota|refus|declin|safety/i;

// Whether a failure is worth one more try. Takes an HTTP status, an error,
// a { status, detail | error | message | code } result, or a tool outcome
// ({ status: 'failed', code }).
export function isTransientFailure(f) {
  if (f == null) return false;
  if (typeof f === 'number') return f === 408 || f === 425 || f === 429 || (f >= 500 && f <= 599);
  const status = Number.isInteger(f.status) ? f.status : Number.isInteger(f.httpStatus) ? f.httpStatus : null;
  const text = String(f.detail || f.error || f.message || f.code || f.reason || '');
  if (FINAL_TEXT_RE.test(text)) return false;
  if (f.name === 'AbortError' || f.name === 'TimeoutError') return true;
  if (f.code === 'upstream_unavailable' || f.code === 'timeout') return true;
  if (status != null) return isTransientFailure(status);
  return TRANSIENT_TEXT_RE.test(text);
}

// Runs attempt() and, when it throws or resolves to a failure that
// `failed(result)` says is transient, once more after `backoffMs`.
// Resolves to { result, retried } or rejects with the second error.
export async function retryOnce(attempt, { failed = (r) => r && r.ok === false && isTransientFailure(r), backoffMs = RETRY_BACKOFF_MS, sleep = defaultSleep, onRetry = () => {} } = {}) {
  let first;
  try {
    first = await attempt(1);
  } catch (e) {
    if (!isTransientFailure(e)) throw e;
    try { onRetry({ reason: 'error', error: e }); } catch (x) { /* never breaks the call */ }
    await sleep(backoffMs);
    return { result: await attempt(2), retried: true };
  }
  if (!failed(first)) return { result: first, retried: false };
  try { onRetry({ reason: 'failed', result: first }); } catch (x) { /* never breaks the call */ }
  await sleep(backoffMs);
  return { result: await attempt(2), retried: true };
}
