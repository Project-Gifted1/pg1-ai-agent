// The real dependencies of the Foundry pipeline: storage, the purpose
// classifier (paid light models, loaded only when a request is screened),
// the lab (build, sync, gate) and operator notices. api/a2a.mjs loads this
// module lazily, so the A2A check path never reaches the lab or model code.

import { createFoundryStore } from './store.mjs';
import { startLabExperiment, syncLabExperiment, FOUNDRY_GOAL_PREFIX } from '../lab/chat.mjs';
import { createLabStore, ACTIVE_LAB_STATUSES } from '../lab/store.mjs';
import { createLabGithub } from '../lab/github.mjs';
import { evaluateGate } from '../lab/gate.mjs';
import { labBudgetUsd } from '../lab/policy.mjs';
import { classifyPurpose } from './screen.mjs';
import { notifyOperator } from '../notify.mjs';

export function labReady(env = process.env) {
  return !!String(env.PG1_LAB_DISPATCH_SECRET || '').trim() && createLabGithub({ env }).configured;
}

export function foundryDeps({ supUrl, supKey, env = process.env, fetchImpl = globalThis.fetch, callerHash = null }) {
  const store = createFoundryStore({ supUrl, supKey, fetchImpl });
  const notify = (n) => notifyOperator({ supUrl, supKey, ...n });
  return {
    store,
    callerHash,
    notify,
    labBudgetUsd: labBudgetUsd(env),
    labReady: () => labReady(env),
    classify: async (purpose) => {
      const { foundryClassifierModel } = await import('../a2aJobs/service.mjs');
      return classifyPurpose(purpose, { model: foundryClassifierModel({ env, fetchImpl }) });
    },
    startBuild: (job) => startLabExperiment({
      env, supUrl, supKey, fetchImpl,
      kind: 'code',
      action: 'foundry:build',
      goal: `${FOUNDRY_GOAL_PREFIX} Build the PG1 Foundry tool ft_${job.spec.name} as a declarative plan file foundry/tools/${job.spec.name}.json with evals; no new runtime code.`,
      input: { foundry_job_id: job.id, spec: job.spec, plan: job.plan, quote: job.quote }
    }),
    // Syncs the lab run and runs the lab gate with the Foundry's own
    // licence (PG1 primitives only: no outside sources) and cost inputs.
    evaluate: async (job) => {
      const labStore = createLabStore({ supUrl, supKey, fetchImpl });
      const gh = createLabGithub({ env, fetchImpl });
      const exp = await labStore.get(job.lab_experiment_id);
      if (!exp) return { state: 'pending' };
      if (ACTIVE_LAB_STATUSES.includes(exp.status)) {
        if (!gh.configured) return { state: 'pending' };
        await syncLabExperiment(exp, { store: labStore, gh, supUrl, supKey, fetchImpl });
      }
      if (ACTIVE_LAB_STATUSES.includes(exp.status)) return { state: 'pending' };
      if (exp.status !== 'done') return { state: 'fail', why: exp.status };
      const full = await labStore.get(exp.id);
      const candidate = full && full.candidate;
      if (!candidate || candidate.type !== 'code') return { state: 'fail', why: 'produced no pull request' };
      const ci = gh.configured ? await gh.prChecks(candidate.pr_number) : null;
      if (ci && ci.state === 'pending') return { state: 'pending' };
      const gate = evaluateGate({ candidate: { ...candidate, sources: [], pricing: { price_usd: Number(job.per_call_usd), worst_case_cost_usd: Number(job.quote.worst_call_cost_usd) } }, result: full.result || {}, ci });
      await labStore.update(exp.id, { gate });
      return gate.pass ? { state: 'pass', gate } : { state: 'fail', gate, why: 'did not pass the gate' };
    }
  };
}
