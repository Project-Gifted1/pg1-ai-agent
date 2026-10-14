// PG1 watching something on its own (a lab start, a PR it opened, a
// production deploy): the autonomy policy decides ('watch:auto') and the
// decision goes on the audit log. Storage and policy only, so the lab, the
// chat and the hooks can import it without the report and push code.
// Never throws.

import { authorize, autonomyMode, logAutonomy } from '../autonomy.mjs';
import { createWatchStore } from './store.mjs';
import { targetLabel } from './targets.mjs';

export async function autoWatch({ env = process.env, supUrl, supKey, fetchImpl = globalThis.fetch, store = null, type, id, label = '', originThread = null, lastState = null, now = Date.now() }) {
  const audit = { supUrl, supKey, fetchImpl };
  try {
    const mode = autonomyMode(env);
    const d = authorize('watch:auto', { actor: 'pg1', mode });
    if (!d.allowed) {
      await logAutonomy(audit, { action: 'watch:auto', decision: d.decision, mode, detail: `${type} not watched: ${d.reason}` });
      return { ok: false, reason: d.reason };
    }
    const s = store || createWatchStore({ supUrl, supKey, fetchImpl });
    const { watch, created } = await s.create({ type, id, label, originThread, source: 'auto', lastState, now });
    if (created) await logAutonomy(audit, { action: 'watch:auto', decision: 'allowed', mode, outcome: 'watching', detail: targetLabel(type, id) });
    return { ok: true, watch, created };
  } catch (e) {
    console.error(`[watches] auto_watch_failed type=${type} ${e && e.status ? `status=${e.status}` : 'error'}`);
    return { ok: false, reason: 'storage' };
  }
}

