// /auto on | off | status | log [n] | limit <n> | budget <usd>: the
// Autonomous mode switch from chat (signed-in operator only), the same
// switch as the Command Centre header (lib/autonomous/state.mjs). PG1
// words only.

import {
  createAutonomousStore, switchOn, switchOff, setLimits, todaySummary, ACTION_TYPES
} from './state.mjs';

export function isAutoCommand(text) {
  return /^\/auto(?:\s|$)/i.test(String(text || '').trim());
}

export function parseAutoCommand(text) {
  const t = String(text || '').trim().replace(/^\/auto\s*/i, '');
  const [sub = 'status', ...rest] = t.split(/\s+/).filter(Boolean);
  return { sub: sub.toLowerCase(), arg: rest.join(' ') };
}

const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const STATUS_WORDS = { queued: 'queued', running: 'running', done: 'done', failed: 'failed', cancelled: 'cancelled', stopped: 'stopped', refused: 'refused', needs_approval: 'needs approval', approved: 'approved', rejected: 'rejected' };

function irishTime(iso) {
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Dublin', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)); } catch (e) { return String(iso || '').slice(0, 16); }
}

export function logLine(r) {
  return `- ${irishTime(r.at)} · ${ACTION_TYPES[r.type] || r.type} · ${STATUS_WORDS[r.status] || r.status}${r.reason ? ` · ${r.reason}` : ''}${r.result ? ` → ${r.result}` : ''}${Number(r.cost_usd) ? ` · ${usd(r.cost_usd)}` : ''}${r.link ? ` · ${r.link}` : ''}`;
}

export function statusText(state, today) {
  const lines = [
    `### [ AUTONOMOUS MODE: ${state.enabled ? 'ON' : 'OFF'} ]`,
    state.error ? '- The switch could not be read, so it counts as OFF and nothing autonomous starts.' : `- Last changed ${state.changed_at ? irishTime(state.changed_at) : 'never'} by ${state.changed_by === 'auto_off' ? 'a safety stop' : 'the operator'}${state.reason ? `: ${state.reason}` : ''}`,
    `- Today: ${today ? today.count : 0} autonomous action${today && today.count === 1 ? '' : 's'}, ${usd(today ? today.costUsd : 0)} spent${today && today.pendingApprovals ? `, ${today.pendingApprovals} waiting for your approval` : ''}`,
    `- Guardrails: at most ${state.max_actions_per_hour} actions an hour (/auto limit <n>), paid AI budget ${usd(state.daily_budget_usd)} a day (/auto budget <usd>; $0 means free tiers only), off after 3 failures of the same kind in a row`,
    '- Never, whatever the switch says: merges to main, production deploys, schema or data changes, anything sent to clients or the public, a refused task retried elsewhere, secrets in logs'
  ];
  return lines.join('\n');
}

export async function handleAutoCommand({ text, isOperator = false, supUrl, supKey, fetchImpl = globalThis.fetch, notify = null }) {
  if (isOperator !== true) return { status: 401, reply: '[AGENT] Autonomous mode is for the signed-in operator only.' };
  if (!supUrl || !supKey) return { status: 200, reply: 'Autonomous mode needs the vault (Supabase), which is not configured on this deployment. It stays OFF.' };
  const store = createAutonomousStore({ supUrl, supKey, fetchImpl });
  const { sub, arg } = parseAutoCommand(text);
  try {
    if (sub === 'on') {
      await switchOn(store);
      const state = await store.getState();
      if (!state.enabled) return { status: 200, reply: 'Autonomous mode could not be switched on (its table is not set up: supabase/migrations/20261104120000_pg1_autonomous.sql). It stays OFF.', autonomous: { enabled: false } };
      return { status: 200, reply: `Autonomous mode is **ON**. PG1 runs only the allowed autonomous actions, within the guardrails; /auto off stops it at once.\n\n${statusText(state, await todaySummary(store))}`, autonomous: { enabled: true } };
    }
    if (sub === 'off') {
      const out = await switchOff(store, { by: 'operator', reason: 'Switched off by the operator' });
      return { status: 200, reply: `Autonomous mode is **OFF**. Nothing new starts${out.cancelled ? `, ${out.cancelled} queued action${out.cancelled === 1 ? ' was' : 's were'} cancelled` : ''}, and anything running stops at its next safe checkpoint.`, autonomous: { enabled: false } };
    }
    if (sub === 'limit') {
      const n = Number(arg);
      if (!Number.isInteger(n) || n < 1 || n > 1000) return { status: 200, reply: 'Give a whole number of actions an hour, 1 to 1000, e.g. /auto limit 30.' };
      await setLimits(store, { maxPerHour: n });
      return { status: 200, reply: `Autonomous mode now switches itself off after more than ${n} actions in an hour.` };
    }
    if (sub === 'budget') {
      const n = Number(String(arg).replace(/^\$/, ''));
      if (!Number.isFinite(n) || n < 0 || n > 1000) return { status: 200, reply: 'Give a daily amount in USD, 0 to 1000, e.g. /auto budget 0 (free tiers only).' };
      await setLimits(store, { dailyBudgetUsd: n });
      return { status: 200, reply: n === 0 ? 'Autonomous work is back to free tiers only ($0 a day of paid AI).' : `Autonomous work may now spend up to $${n.toFixed(2)} a day on paid AI; it switches itself off when that is used.` };
    }
    if (sub === 'log') {
      const n = Math.max(1, Math.min(100, Number(arg) || 20));
      const rows = await store.listActions({ limit: n });
      return { status: 200, reply: rows.length ? [`### [ AUTONOMOUS LOG · last ${rows.length} ]`, ...rows.map(logLine)].join('\n') : 'No autonomous actions yet.' };
    }
    const state = await store.getState();
    return { status: 200, reply: statusText(state, state.error ? null : await todaySummary(store)), autonomous: { enabled: state.enabled === true } };
  } catch (e) {
    return { status: 200, reply: 'Autonomous mode could not be reached right now. It counts as OFF until it can be read.' };
  }
}
