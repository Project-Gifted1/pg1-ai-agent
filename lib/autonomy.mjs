// PG1's autonomy policy: what PG1 may do on its own, what needs the
// operator's approval, what it may never do, and what outside agents may
// reach. One table (ACTION_TIERS) maps every tool, command and internal
// action to a tier; anything not in it is APPROVAL.
//
//   FREE      read, research, draft, lab work within its budget
//   APPROVAL  spend outside the lab, publish or post, payments, pricing
//             changes, new data sources, contacting people, production
//             data writes, code merges, enabling skills, deploying Foundry
//             tools
//   NEVER     change its own policy, raise its own budgets, reach keys
//             outside its scope, disable the audit log, trade or move funds
//             in any market
//   EXTERNAL  inbound A2A jobs and Foundry tools, limited to the public
//             catalogue tools
//
// Kill switch: PG1_AUTONOMY=off|lab|on (default lab).
//   off  PG1 takes no autonomous action at all (safety actions such as
//        retention and switching off a failing flag still run); the
//        operator's own commands work as before
//   lab  autonomous FREE actions only in the lab and as drafts
//   on   autonomous FREE actions anywhere
// In every mode APPROVAL actions need the operator (an approval card, or
// the operator's own command) and NEVER actions are refused.
//
// Every autonomous decision is written to pg1_autonomy_log (tier, decision,
// cost, outcome); /autonomy shows the last 24 hours. The log is append-only
// for the server (see the migration), so PG1 cannot rewrite or switch off
// its own audit trail.
//
// This file is the policy. The lab may not change it (lib/lab/policy.mjs),
// the patch endpoint refuses it (api/chat.mjs HARD_BLOCKED_PATH_PATTERNS),
// and no tool or command writes environment variables, so nothing PG1 runs
// can raise its budgets or loosen this table.

export const TIERS = Object.freeze({ FREE: 'FREE', APPROVAL: 'APPROVAL', NEVER: 'NEVER', EXTERNAL: 'EXTERNAL' });
export const AUTONOMY_MODES = Object.freeze(['off', 'lab', 'on']);
export const DEFAULT_AUTONOMY_MODE = 'lab';
export const AUTONOMY_LOG_TABLE = 'pg1_autonomy_log';
export const AUTONOMY_LOG_RETENTION_DAYS = 365;

export function autonomyMode(env = process.env) {
  const v = String(env.PG1_AUTONOMY || '').trim().toLowerCase();
  return AUTONOMY_MODES.includes(v) ? v : DEFAULT_AUTONOMY_MODE;
}

const F = TIERS.FREE;
const A = TIERS.APPROVAL;
const N = TIERS.NEVER;
const E = TIERS.EXTERNAL;

// scope: 'lab' marks FREE work that belongs to the lab (allowed in lab
// mode); safety: true runs even with autonomy off.
export const ACTION_TIERS = Object.freeze({
  // --- PG1's read-only checks (MCP tools, A2A skills, chat tools): public catalogue
  'tool:check_wallet_sanctions': { tier: E },
  'tool:check_domain_age': { tier: E },
  'tool:check_hostname_reputation': { tier: E },
  'tool:check_wallet_age': { tier: E },
  'tool:check_package': { tier: E },
  'tool:check_ip_abuse': { tier: E },
  'tool:preflight_check': { tier: E },
  'tool:check_x402_endpoint': { tier: E },
  'tool:check_agent_card': { tier: E },
  'tool:verify_result': { tier: E },
  'tool:get_usage_status': { tier: E },
  'tool:get_ioc_context': { tier: E },
  'tool:get_ioc_batch': { tier: E },
  'tool:get_cve_details': { tier: E },
  'tool:get_cve_batch': { tier: E },
  'tool:get_cve_by_product': { tier: E },
  'tool:get_threat_actor_profile': { tier: E },
  'tool:get_threat_indicators': { tier: E },
  // Writes from outside agents: staged for review, never applied directly.
  'tool:subscribe_alerts': { tier: A },
  'tool:submit_indicator': { tier: A },
  // Operator-only chat tools
  'tool:get_usage_stats': { tier: F },
  'tool:search_history': { tier: F },
  'tool:load_skill': { tier: F },
  'tool:generate_video': { tier: A }, // paid media spend outside the lab

  // --- operator commands (the operator's own command is the approval)
  'command:/help': { tier: F }, 'command:/auth': { tier: F }, 'command:/status': { tier: F },
  'command:/usage': { tier: F }, 'command:/spend': { tier: F }, 'command:/threat-radar': { tier: F },
  'command:/commerce-status': { tier: F }, 'command:/sync-vault': { tier: F }, 'command:/export': { tier: F },
  'command:/vault': { tier: F }, 'command:/test-validator': { tier: F }, 'command:/voice': { tier: F },
  'command:/task': { tier: F }, 'command:/pin': { tier: F }, 'command:/unpin': { tier: F },
  'command:/pdf': { tier: F }, 'command:/learn': { tier: F }, 'command:/skills': { tier: F },
  'command:/skills enable': { tier: A }, 'command:/autonomy': { tier: F },
  'command:/lab start': { tier: F, scope: 'lab' }, 'command:/lab status': { tier: F, scope: 'lab' },
  'command:/lab stop': { tier: F, scope: 'lab' }, 'command:/lab report': { tier: F, scope: 'lab' },
  'command:/promote': { tier: A },
  'command:/core': { tier: F }, 'command:/claude': { tier: F }, 'command:/speak': { tier: F }, 'command:/tts': { tier: F }, 'command:/image': { tier: A },
  'command:/video': { tier: A }, 'command:/film': { tier: A }, 'command:/music': { tier: A },
  'command:/code': { tier: F }, 'command:/approve': { tier: A }, 'command:/decline': { tier: F },
  'command:/patch': { tier: A }, 'command:/deploy-cron': { tier: A }, 'command:/build-validator': { tier: A },
  'command:/smoke': { tier: F },
  'command:/opportunities': { tier: F }, 'command:/a2a': { tier: F }, 'command:/foundry': { tier: F },
  'command:/watchlists': { tier: F },

  // --- what PG1 does on its own
  'context:task_update': { tier: F }, // the cheap model's task state / summary update
  'skill:draft': { tier: F }, // /learn, the lab's drafts (never active)
  'skill:suggest': { tier: F },
  'skill:enable': { tier: A },
  'lab:dispatch': { tier: F, scope: 'lab' },
  'lab:ingest': { tier: F, scope: 'lab' },
  'lab:research': { tier: F, scope: 'lab' },
  'lab:draft_pr': { tier: F, scope: 'lab' },
  'lab:approval_card': { tier: F, scope: 'lab' }, // asking is free; acting on it is the operator's
  'opportunity:research': { tier: F, scope: 'lab' },
  'opportunity:prototype': { tier: F, scope: 'lab' },
  'flag:operator_rollout': { tier: A },
  'flag:public_rollout': { tier: A },
  'flag:auto_disable': { tier: F, safety: true },
  'retention:purge': { tier: F, safety: true },
  'alert:operator': { tier: F, safety: true },
  'spend:outside_lab': { tier: A },
  'publish:post': { tier: A },
  'payment:make': { tier: A },
  'payment:refund': { tier: A },
  'pricing:change': { tier: A },
  'data_source:add': { tier: A },
  'contact:person': { tier: A },
  'production:write': { tier: A },
  'code:merge': { tier: A },
  'foundry:deploy': { tier: A },
  'directory:register': { tier: A },
  'package:publish': { tier: A },
  'signals:enable': { tier: A },

  // --- outside agents
  'a2a:job': { tier: E },
  'a2a:quote': { tier: E },
  'foundry:tool_call': { tier: E },
  'foundry:build_request': { tier: E },
  'watchlist:subscribe': { tier: E },

  // --- never
  'policy:change': { tier: N },
  'budget:raise': { tier: N },
  'keys:out_of_scope': { tier: N },
  'audit:disable': { tier: N },
  'audit:edit': { tier: N },
  'funds:trade': { tier: N },
  'funds:move': { tier: N },
  'env:write': { tier: N }
});

// The public catalogue: the only tools an EXTERNAL caller may reach.
export const PUBLIC_CATALOGUE_TOOLS = Object.freeze(Object.keys(ACTION_TIERS).filter((k) => k.startsWith('tool:') && ACTION_TIERS[k].tier === E).map((k) => k.slice(5)));

export function tierOf(action) {
  const a = ACTION_TIERS[String(action || '')];
  return a ? a.tier : A; // unmapped means APPROVAL
}

export function isMapped(action) {
  return Object.hasOwn(ACTION_TIERS, String(action || ''));
}

// The decision for one action. actor: 'pg1' (autonomous), 'operator' (the
// signed-in operator's own command), 'external' (an outside agent).
// approved: an approval card for this action was approved.
// Returns { allowed, tier, decision, reason } where decision is 'allowed',
// 'denied' or 'needs_approval'.
export function authorize(action, { actor = 'pg1', mode = autonomyMode(), approved = false, catalogueTool = null } = {}) {
  const entry = ACTION_TIERS[String(action || '')] || null;
  const tier = entry ? entry.tier : A;
  const out = (allowed, decision, reason) => ({ allowed, tier, decision, reason, action: String(action || ''), mapped: !!entry });
  if (tier === N) return out(false, 'denied', 'never allowed');
  if (actor === 'external') {
    if (tier !== E) return out(false, 'denied', 'outside agents reach only the public catalogue');
    if (action === 'foundry:tool_call' || action.startsWith('tool:')) {
      const name = action.startsWith('tool:') ? action.slice(5) : catalogueTool;
      if (action.startsWith('tool:') && !PUBLIC_CATALOGUE_TOOLS.includes(name)) return out(false, 'denied', 'not a public catalogue tool');
    }
    if (mode === 'off' && (action.startsWith('a2a:') || action.startsWith('foundry:'))) return out(false, 'denied', 'autonomy is off');
    return out(true, 'allowed', 'public catalogue');
  }
  if (actor === 'operator') {
    if (tier === A) return out(true, 'allowed', 'the operator\'s own command');
    return out(true, 'allowed', tier === E ? 'public tool, run by the operator' : 'free');
  }
  // PG1 on its own.
  if (tier === A) return approved ? out(true, 'allowed', 'approved by the operator') : out(false, 'needs_approval', 'needs the operator\'s approval');
  if (tier === E) return out(true, 'allowed', 'public tool');
  if (entry && entry.safety) return out(true, 'allowed', 'safety action');
  if (mode === 'off') return out(false, 'denied', 'autonomy is off (PG1_AUTONOMY=off)');
  if (mode === 'lab' && !(entry && (entry.scope === 'lab' || /^(?:skill:draft|skill:suggest|context:|tool:)/.test(action)))) return out(false, 'denied', 'outside the lab while PG1_AUTONOMY=lab');
  return out(true, 'allowed', 'free');
}

// The action name for a slash command: "/skills enable x" → "command:/skills enable".
export function commandAction(text) {
  const t = String(text || '').trim().toLowerCase();
  const m = /^(\/[a-z0-9-]+)(?:\s+([a-z-]+))?/.exec(t);
  if (!m) return null;
  const two = m[2] ? `command:${m[1]} ${m[2]}` : null;
  if (two && isMapped(two)) return two;
  return `command:${m[1]}`;
}

// --- the audit log ---------------------------------------------------------------

function headers(supKey, extra = {}) {
  return { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json', ...extra };
}

const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, n);

// One row per autonomous decision. Fixed fields only: never content, a
// caller, an address or a key. Never throws.
export async function logAutonomy({ supUrl, supKey, fetchImpl = globalThis.fetch }, { action, tier, actor = 'pg1', decision, mode = autonomyMode(), costUsd = 0, outcome = null, detail = '', requestId = null }) {
  if (!supUrl || !supKey) return false;
  try {
    const res = await fetchImpl(`${supUrl}/rest/v1/${AUTONOMY_LOG_TABLE}`, {
      method: 'POST',
      headers: headers(supKey, { Prefer: 'return=minimal' }),
      body: JSON.stringify({ action: clean(action, 64), tier: tier || tierOf(action), actor: ['pg1', 'operator', 'external', 'lab'].includes(actor) ? actor : 'pg1', decision: clean(decision, 20), mode, cost_usd: Math.max(0, Number(costUsd) || 0), outcome: outcome ? clean(outcome, 20) : null, detail: clean(detail, 200) || null, request_id: requestId ? clean(requestId, 64) : null })
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

// authorize() and log the decision in one step, for autonomous actions.
export async function decide(action, ctx = {}, opts = {}) {
  const d = authorize(action, opts);
  if (opts.actor !== 'operator' || d.tier !== TIERS.FREE) {
    await logAutonomy(ctx, { action, tier: d.tier, actor: opts.actor || 'pg1', decision: d.decision, mode: opts.mode || autonomyMode(), costUsd: opts.costUsd || 0, outcome: opts.outcome || null, detail: opts.detail || d.reason, requestId: opts.requestId || null });
  }
  return d;
}

export async function recentAutonomy({ supUrl, supKey, fetchImpl = globalThis.fetch, now = Date.now(), hours = 24 }) {
  const since = new Date(now - hours * 3600000).toISOString();
  const res = await fetchImpl(`${supUrl}/rest/v1/${AUTONOMY_LOG_TABLE}?select=at,action,tier,actor,decision,mode,cost_usd,outcome,detail&at=gte.${encodeURIComponent(since)}&order=at.desc&limit=500`, { headers: headers(supKey) });
  if (!res.ok) throw new Error(`autonomy log ${res.status}`);
  return res.json();
}

export function autonomyReport(rows, { mode = autonomyMode() } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const by = (k) => list.reduce((m, r) => { m[r[k]] = (m[r[k]] || 0) + 1; return m; }, {});
  const cost = list.reduce((n, r) => n + (Number(r.cost_usd) || 0), 0);
  const fmt = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  return [
    '### [ AUTONOMY · last 24 hours ]',
    `- **Mode**: ${mode} (PG1_AUTONOMY=off|lab|on; off stops every autonomous action)`,
    `- **Actions**: ${list.length} · by tier: ${fmt(by('tier'))} · by decision: ${fmt(by('decision'))}`,
    `- **Cost**: $${cost.toFixed(2)}`,
    ...(list.length ? ['', ...list.slice(0, 20).map((r) => `- ${String(r.at).slice(11, 16)} UTC · ${r.action} · ${r.tier} · ${r.decision}${r.outcome ? ` · ${r.outcome}` : ''}${Number(r.cost_usd) ? ` · $${Number(r.cost_usd).toFixed(2)}` : ''}${r.detail ? ` · ${r.detail}` : ''}`)] : ['', 'No autonomous actions in the last 24 hours.'])
  ].join('\n');
}
