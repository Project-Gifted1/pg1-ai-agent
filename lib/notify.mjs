// Alerts for the operator: one row in the error log (pg1_errors, category
// "alert"), which the ➕ menu's ERROR LOG and "what's broken?" already show.
// Fixed reason words and a short message; never a key, a caller or an
// address.

import { logApiError } from './errorLog.mjs';

export async function notifyOperator({ supUrl, supKey, route = '/autonomy', reason, message, log = logApiError }) {
  if (!supUrl || !supKey) return false;
  try {
    await log(supUrl, supKey, { source: 'server', route: String(route).slice(0, 80), status: null, reason: String(reason || 'alert').slice(0, 120), message: String(message || '').slice(0, 300), category: 'alert' });
    return true;
  } catch (e) {
    return false;
  }
}
