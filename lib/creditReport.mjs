// Paid AI credit per account, for the operator (/keys and /usage): how much
// each paid account has left and what it was spent on (text, media, voice).
//
// Routing policy: paid credit is for media (video clips, music, stills);
// text runs on the free engines first and reaches a paid account only when
// every free engine failed or could not fit. This view shows whether that
// holds: a paid account with text spend is worth a look.
//
// Left:
//   live        the account's own balance where the engine has an endpoint
//               for it (OpenRouter, the AI gateway; ElevenLabs in
//               characters: voice stays on its plan)
//   estimated   PG1_CREDIT_<ACCOUNT>_USD (what the operator topped up) minus
//               PG1's ledger since PG1_CREDIT_<ACCOUNT>_SINCE (YYYY-MM-DD,
//               default the 1st of this month, UTC); an estimate from list
//               prices, the invoice is the truth
//   unknown     neither: the engine shows no balance and none was set
// Spent: the ledger (pg1_ai_usage) since the same day, by kind, through
// pg1_ai_spend_by_kind (supabase/migrations/20261103120000_pg1_ai_spend_by_kind.sql);
// without it, this instance's figures for today only, and the view says so.
//
// Operator-only output: engine names as /keys already shows them.

import { memoryLedger, utcDay, isPaidProvider } from './aiRouter.mjs';

export const SPEND_BY_KIND_RPC = 'pg1_ai_spend_by_kind';
export const PAID_ACCOUNTS = Object.freeze([
  ['anthropic', 'Anthropic (Claude)'],
  ['gemini_paid', 'Gemini (paid key)'],
  ['openrouter', 'OpenRouter'],
  ['gateway', 'AI gateway'],
  ['openai', 'OpenAI'],
  ['replicate', 'Replicate'],
  ['elevenlabs', 'ElevenLabs'],
  ['cartesia', 'Cartesia']
]);

// Accounts whose balance /keys reads live.
const LIVE_BALANCE = new Set(['openrouter', 'gateway', 'elevenlabs']);
const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;
export const creditEnvName = (account) => `PG1_CREDIT_${String(account).toUpperCase()}_USD`;
export const creditSinceEnvName = (account) => `PG1_CREDIT_${String(account).toUpperCase()}_SINCE`;

export function monthStart(now = Date.now()) {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export function creditSetting(env = {}, account, now = Date.now()) {
  const raw = String(env[creditEnvName(account)] ?? '').trim();
  const usd = raw === '' ? null : Number(raw);
  const sinceRaw = String(env[creditSinceEnvName(account)] ?? '').trim();
  const since = /^\d{4}-\d{2}-\d{2}$/.test(sinceRaw) ? sinceRaw : monthStart(now);
  return { usd: Number.isFinite(usd) && usd >= 0 ? usd : null, since };
}

export function kindOf(row) {
  const unit = row.unit || '';
  if (row.task === 'tts' || /^(?:tts|dialogue|sts)_/.test(unit)) return 'voice';
  if (!unit && (row.task === 'light' || row.task === 'heavy')) return 'text';
  return 'media';
}

// { scope: 'ledger' | 'instance', since, byAccount: { [account]: { text, media, voice } } }
export async function spendByKind({ supUrl = '', supKey = '', fetchImpl = globalThis.fetch, since, now = Date.now() } = {}) {
  const byAccount = {};
  const add = (p, kind, usd) => {
    const a = byAccount[p] || (byAccount[p] = { text: 0, media: 0, voice: 0 });
    a[kind] += Number(usd) || 0;
  };
  if (supUrl && supKey) {
    try {
      const res = await fetchImpl(`${supUrl}/rest/v1/rpc/${SPEND_BY_KIND_RPC}`, {
        method: 'POST',
        headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_since: since }),
        cache: 'no-store'
      });
      if (res && res.ok) {
        const rows = await res.json();
        if (Array.isArray(rows)) {
          for (const r of rows) if (['text', 'media', 'voice'].includes(r.kind)) add(r.provider, r.kind, r.cost_usd);
          return { scope: 'ledger', since, byAccount };
        }
      }
    } catch (e) { /* fall back to this instance's figures */ }
  }
  const today = utcDay(now);
  for (const r of memoryLedger.rows(today)) if (r.ok && !r.cached) add(r.provider, kindOf(r), r.cost_usd);
  return { scope: 'instance', since: today, byAccount };
}

// [{ account, label, left, leftKind: 'live'|'estimated'|'unknown', spent: { text, media, voice } }]
export function creditRows({ env = {}, keyRows = [], spend = { byAccount: {} }, now = Date.now() } = {}) {
  const keys = new Map(keyRows.map((r) => [r.engine, r]));
  return PAID_ACCOUNTS.filter(([a]) => isPaidProvider(a)).map(([account, label]) => {
    const k = keys.get(account);
    const spent = spend.byAccount[account] || { text: 0, media: 0, voice: 0 };
    const set = k ? k.set !== false : false;
    let left = null;
    let leftKind = 'unknown';
    if (k && Number.isFinite(k.balanceUsd)) { left = money(k.balanceUsd); leftKind = 'live'; }
    else if (k && Number.isFinite(k.charsLeft)) { left = `${k.charsLeft.toLocaleString('en-GB')} of ${k.charsLimit.toLocaleString('en-GB')} characters`; leftKind = 'live'; }
    else {
      const c = creditSetting(env, account, now);
      if (c.usd != null) { left = money(Math.max(0, c.usd - spent.text - spent.media - spent.voice)); leftKind = 'estimated'; }
    }
    return { account, label, set, state: k ? k.state : null, left, leftKind, spent };
  });
}

// The markdown section ("### Paid AI credit") for /keys and /usage.
export function creditSection(rows, spend) {
  const lines = ['### Paid AI credit', '', '| Account | Left | Spent on text | Spent on media | Spent on voice |', '|---|---|---|---|---|'];
  const shown = rows.filter((r) => r.set || r.spent.text || r.spent.media || r.spent.voice);
  for (const r of shown) {
    const left = r.left != null ? `${r.left}${r.leftKind === 'estimated' ? ' (estimated)' : ''}`
      : !r.set ? 'no key'
        : r.state === 'not checked' && LIVE_BALANCE.has(r.account) ? 'not read yet (/keys reads it)'
          : `not shown by the engine (set ${creditEnvName(r.account)})`;
    lines.push(`| ${r.label} | ${left} | ${money(r.spent.text)} | ${money(r.spent.media)} | ${money(r.spent.voice)} |`);
  }
  if (!shown.length) lines.push('| (no paid account set) | - | - | - | - |');
  const textTotal = shown.reduce((s, r) => s + r.spent.text, 0);
  const scope = spend.scope === 'ledger' ? `since ${spend.since} (UTC; an account with its own PG1_CREDIT_*_SINCE from that day), all instances` : `today only, this server instance (the spend-by-kind function is not installed)`;
  lines.push('', `Spent ${scope}. Paid credit is kept for media; text goes to the free engines first${textTotal > 0 ? `, and ${money(textTotal)} of text reached a paid account (every free engine failed or could not fit)` : ''}.`);
  return lines.join('\n');
}

export async function creditReport({ env = {}, keyRows = [], supUrl = '', supKey = '', fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  // Each account's spend is counted from its own top-up date (default the
  // 1st of this month): one ledger read per distinct date.
  const sinceOf = Object.fromEntries(PAID_ACCOUNTS.map(([a]) => [a, creditSetting(env, a, now).since]));
  const dates = [...new Set(Object.values(sinceOf))].sort();
  const reads = Object.fromEntries(await Promise.all(dates.map(async (d) => [d, await spendByKind({ supUrl, supKey, fetchImpl, since: d, now })])));
  const first = reads[dates[0]];
  const spend = { scope: first.scope, since: first.since, byAccount: {} };
  for (const [a] of PAID_ACCOUNTS) if (reads[sinceOf[a]].byAccount[a]) spend.byAccount[a] = reads[sinceOf[a]].byAccount[a];
  const rows = creditRows({ env, keyRows, spend, now });
  return { rows, spend, markdown: creditSection(rows, spend) };
}
