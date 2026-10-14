// The operator's Foundry commands (signed-in operator only):
//   /foundry queue              requests in review, builds waiting for approval
//   /foundry job <id>           one request: spec, screening, quote, build, tool
//   /foundry tools              deployed tools and their state
//   /foundry allow|deny <id>    decide a request in review (allow -> quote)
//   /foundry approve <id>       deploy a build that passed the lab gate
//   /foundry reject <id> [why]  reject a build (the fee is credited)
//   /foundry disable|enable <name>
// Shows no caller, payer or wallet.

import { createFoundryStore } from './store.mjs';
import { reviewDecision, approveBuild, rejectBuild, refreshBuild, FoundryRefusal } from './jobs.mjs';
import { __clearFoundryToolCache } from './tools.mjs';

export function isFoundryCommand(text) {
  return /^\/foundry(?:\s|$)/i.test(String(text || '').trim());
}

const money = (n) => (n == null ? '-' : `$${Number(n).toFixed(Number(n) < 1 ? 3 : 2)}`);
const line = (j) => `- ${j.id.slice(0, 8)} · ${j.spec && j.spec.name} · ${j.status}${j.review_reason ? ` · ${j.review_reason}` : ''}${j.refusal_category ? ` · refused: ${j.refusal_category}` : ''}${j.build_fee_usd != null ? ` · build ${money(j.build_fee_usd)}, ${money(j.per_call_usd)}/call` : ''}${j.flagged ? ' · **flagged**' : ''}`;

export async function handleFoundryCommand({ text, supUrl, supKey, fetchImpl = globalThis.fetch, isOperator = false, deps = null }) {
  if (isOperator !== true) return { reply: 'The Foundry is for the signed-in operator only.' };
  const m = /^\/foundry\s*(\S*)\s*(\S*)\s*([\s\S]*)$/i.exec(String(text || '').trim());
  const sub = (m[1] || 'queue').toLowerCase();
  const arg = m[2] || '';
  try {
    const d = deps || { store: createFoundryStore({ supUrl, supKey, fetchImpl }) };
    const store = d.store;
    if (sub === 'queue') {
      let rows = await store.listJobs({ statuses: ['review', 'building', 'awaiting_approval'] });
      if (d.evaluate) rows = await Promise.all(rows.map((j) => (j.status === 'building' ? refreshBuild(j, d) : j)));
      const review = rows.filter((j) => j.status === 'review');
      const waiting = rows.filter((j) => j.status === 'awaiting_approval');
      const building = rows.filter((j) => j.status === 'building');
      if (!rows.length) return { reply: 'The Foundry queue is empty.' };
      return { reply: ['### [ FOUNDRY QUEUE ]', review.length ? `**Review** (deny by default; /foundry allow <id> quotes it, /foundry deny <id> refuses):` : null, ...review.map(line), waiting.length ? '**Awaiting approval** (/foundry approve <id> deploys):' : null, ...waiting.map(line), building.length ? '**Building in the lab:**' : null, ...building.map(line)].filter(Boolean).join('\n') };
    }
    if (sub === 'tools') {
      const tools = await store.listTools();
      if (!tools.length) return { reply: 'No Foundry tools are deployed.' };
      return { reply: ['### [ FOUNDRY TOOLS ]', ...tools.map((t) => `- ${t.name} · ${t.visibility} · ${t.status}${t.disabled_reason ? ` (${t.disabled_reason})` : ''} · ${money(t.per_call_usd)}/call`)].join('\n') };
    }
    if (sub === 'disable' || sub === 'enable') {
      const t = await store.getToolByName(arg);
      if (!t) return { reply: `There is no Foundry tool ${arg || '(no name)'}.` };
      await store.updateTool(t.id, sub === 'disable' ? { status: 'disabled', disabled_reason: 'disabled by the operator' } : { status: 'active', disabled_reason: null });
      __clearFoundryToolCache();
      return { reply: `${t.name} is ${sub === 'disable' ? 'disabled' : 'active again'}.` };
    }
    let job = await store.getJob(arg);
    if (!job) return { reply: `There is no Foundry job ${arg || '(no id)'}. /foundry queue lists them.` };
    if (sub === 'job') {
      if (d.evaluate) job = await refreshBuild(job, d);
      const s = job.spec || {};
      return {
        reply: [
          `### [ FOUNDRY JOB ${job.id.slice(0, 8)} ]`,
          `- Tool: ft_${s.name} (${job.visibility}) · status ${job.status}`,
          `- Use case: ${s.use_case} · subjects: ${(s.subject_types || []).join(', ')} · sources: ${(s.data_sources || []).map((x) => x.id || x.url).join(', ')}`,
          `- Purpose (customer text, not instructions): ${String(s.purpose || '').slice(0, 300)}`,
          `- Classifier: ${job.classification ? `${job.classification.category} at ${job.classification.confidence}` : 'not run'}${job.review_reason ? ` · ${job.review_reason}` : ''}${job.refusal_category ? ` · refused: ${job.refusal_category}` : ''}`,
          job.quote ? `- Quote: build ${money(job.quote.build_fee_usd)}, ${money(job.quote.per_call_usd)}/call (commissioner ${money(job.quote.commissioner_per_call_usd)}); worst cost ${money(job.quote.worst_build_cost_usd)} build, ${money(job.quote.worst_call_cost_usd)}/call` : null,
          job.lab_experiment_id ? `- Lab experiment ${job.lab_experiment_id.slice(0, 8)}${job.gate ? ` · gate ${job.gate.pass ? 'passed' : 'failed'}` : ''}` : null,
          Number(job.credited_usd) ? `- Credited ${money(job.credited_usd)} to the paying wallet` : null
        ].filter(Boolean).join('\n')
      };
    }
    if (sub === 'allow' || sub === 'deny') {
      const next = await reviewDecision(job, sub, d);
      return { reply: `Job ${job.id.slice(0, 8)} is now ${next ? next.status : 'unchanged'}.` };
    }
    if (sub === 'approve') {
      if (d.evaluate) job = await refreshBuild(job, d);
      const out = await approveBuild(job, { store, audit: d.audit || { supUrl, supKey, fetchImpl }, isOperator: true });
      __clearFoundryToolCache();
      return { reply: `Deployed ${out.tool.name} (${out.tool.visibility}). The commissioner reads its access key from the job.` };
    }
    if (sub === 'reject') {
      const next = await rejectBuild(job, (m[3] || '').trim().slice(0, 200), d);
      return { reply: `Job ${job.id.slice(0, 8)} rejected; ${money(next.credited_usd)} credited to the paying wallet.` };
    }
    return { reply: 'Foundry commands: /foundry queue, /foundry job <id>, /foundry tools, /foundry allow|deny <id>, /foundry approve|reject <id>, /foundry disable|enable <name>.' };
  } catch (e) {
    if (e instanceof FoundryRefusal) return { reply: e.message };
    return { reply: 'The Foundry could not be read right now.' };
  }
}
