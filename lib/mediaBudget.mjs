// CONFIRM A BUDGET for /image, /video and /music: the same step as /movie
// and /film (lib/movie/chat.mjs MOVIE_BUDGET). With PG1_DAILY_SPEND_CAP_USD
// at its $0 default nothing paid runs on its own, so these media requests
// show their worst-case cost first, with Confirm / Cancel buttons (and an
// optional --budget <usd>). Nothing spends before Confirm. Confirm writes
// the spend confirmation and grants a job-scoped allowance up to the
// confirmed amount (lib/aiRouter.mjs withSpendAllowance in this function,
// grantSpendAllowance in the music worker), never more; the per-provider
// caps still apply. Cancel discards it.
//
// The proposal is a pending_actions row (action_type MEDIA_BUDGET) whose
// plan carries { kind, request, worstUsd, capUsd }; /approve and /decline
// (api/chat.mjs) resolve it. White-label: replies say PG1 Vision, PG1
// Motion and PG1 Sound, never an engine.

// The proposal's buttons, as on the /movie budget (lib/movie/chat.mjs).
export const CONFIRM_LABELS = Object.freeze({ approve: 'Confirm', decline: 'Cancel' });

export const MEDIA_BUDGET_ACTION = 'MEDIA_BUDGET';
export const MEDIA_KINDS = Object.freeze(['image', 'video', 'music']);
export const MEDIA_LABELS = Object.freeze({ image: 'PG1 Vision', video: 'PG1 Motion', music: 'PG1 Sound' });
export const MEDIA_WORDS = Object.freeze({ image: 'image', video: 'clip', music: 'track' });
export const MEDIA_BUDGET_TTL_MINUTES = 60;

export const isMediaBudgetAction = (actionType) => actionType === MEDIA_BUDGET_ACTION;

const usd = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
// Worst cases are rounded up to the cent, so the cap always covers them.
export const ceilCents = (n) => Math.ceil((Number(n) || 0) * 100 - 1e-9) / 100;

// "--budget 0.50" (or "--budget $0.50") anywhere in the text: the amount and
// the text without it. A malformed amount is an error, never ignored.
export function parseBudgetFlag(text) {
  const t = String(text || '');
  const m = /(^|\s)--budget(?:\s+|=)\$?([^\s]*)/i.exec(t);
  if (!m) return { text: t.trim(), budgetUsd: null };
  const n = Number(m[2]);
  const rest = (t.slice(0, m.index) + t.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
  if (!/^\d{1,4}(?:\.\d{1,2})?$/.test(m[2]) || !(n > 0)) return { text: rest, budgetUsd: null, error: 'The budget must be an amount in USD above 0, for example --budget 0.50.' };
  return { text: rest, budgetUsd: n };
}

// The cap the job runs under: the operator's --budget, else the worst case.
export function mediaCapUsd({ worstUsd, budgetUsd = null }) {
  return budgetUsd != null ? Number(budgetUsd) : ceilCents(worstUsd);
}

// The proposal: { reply, pendingApproval, mediaBudget } or { reply } when
// the budget cannot cover even one paid call (minUsd).
// store: anything with createPendingAction (lib/music/store.mjs).
export async function proposeMediaBudget({ store, kind, request, worstUsd, budgetUsd = null, minUsd = 0, detail = '' }) {
  if (!MEDIA_KINDS.includes(kind)) throw new Error(`unknown media kind ${kind}`);
  const label = MEDIA_LABELS[kind];
  const worst = ceilCents(worstUsd);
  const capUsd = mediaCapUsd({ worstUsd: worst, budgetUsd });
  if (budgetUsd != null && minUsd > 0 && budgetUsd + 1e-9 < minUsd) {
    return { reply: `${label}: a budget of ${usd(budgetUsd)} USD cannot cover even one ${MEDIA_WORDS[kind]} (at least ${usd(minUsd)} USD). Nothing was started and nothing was spent.` };
  }
  const text = [
    `${label}: confirm the budget for this ${MEDIA_WORDS[kind]}. Nothing is spent before you do.`,
    detail,
    `Worst-case cost: ${usd(worst)} USD.`,
    `Hard cap: ${usd(capUsd)} USD (${budgetUsd != null ? 'your --budget' : 'the worst case'}); it never spends more, and stops if the next paid call could go over it.`,
    budgetUsd != null && budgetUsd + 1e-9 < worst ? `Your budget is below the worst case, so it may stop before it is finished; nothing over the budget is spent.` : '',
    'Confirm to start, or Cancel.'
  ].filter(Boolean).join('\n');
  const proposal = await store.createPendingAction({ actionType: MEDIA_BUDGET_ACTION, plan: { kind, request, worstUsd: worst, capUsd }, diffSummary: text, ttlMinutes: MEDIA_BUDGET_TTL_MINUTES });
  return {
    reply: text,
    pendingApproval: { token: proposal.token, expiresAt: proposal.expiresAt, labels: CONFIRM_LABELS },
    mediaBudget: { kind, worstUsd: worst, capUsd }
  };
}

// The confirmation written on the job when the operator confirms (the same
// shape as lib/film/dispatch.mjs spendConfirmation).
export function mediaSpendConfirmation(capUsd, now = Date.now()) {
  return { stage: 'all', cap_usd: Math.max(0, Number(capUsd) || 0), at: new Date(now).toISOString() };
}

// What a confirmed job may still spend: its confirmed cap less its spend
// (0 without a confirmation).
export function confirmedMediaAllowanceUsd(confirmation, spentUsd = 0) {
  if (!confirmation || typeof confirmation !== 'object') return 0;
  return Math.max(0, Math.round(((Number(confirmation.cap_usd) || 0) - (Number(spentUsd) || 0)) * 1e6) / 1e6);
}

// pending_actions for a proposal made outside a film or track store
// (/image, /video): service role, the same row shape as the others.
export function createPendingStore({ supUrl, supKey, fetchImpl = globalThis.fetch }) {
  return {
    async createPendingAction({ actionType, plan, diffSummary, ttlMinutes = MEDIA_BUDGET_TTL_MINUTES }) {
      const token = globalThis.crypto.randomUUID();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlMinutes * 60000);
      const res = await fetchImpl(`${supUrl}/rest/v1/pending_actions`, {
        method: 'POST',
        headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify([{ token, action_type: actionType, plan, diff_summary: String(diffSummary || '').slice(0, 20000), status: 'pending', created_at: now.toISOString(), expires_at: expiresAt.toISOString() }])
      });
      if (!res.ok) throw new Error(`could not store the proposal: ${res.status}`);
      return { token, expiresAt: expiresAt.toISOString() };
    }
  };
}

export function cancelledReply(kind) {
  return `${MEDIA_LABELS[kind] || 'PG1'}: cancelled. Nothing was started and nothing was spent.`;
}
