// The real dependencies of an A2A job: PG1's read-only handlers (fixtures
// first, then the live handler with the paid-caller standing), the vault
// for outputs (signed links, 7 days), the PDF maker, and one model call
// for the write-up on the paid keys (customer data never goes to the free
// key; lib/aiRouter.mjs).

import { runReadOnlyTool, resolveTestFixture } from '../../api/mcp.mjs';
import { makeDocument } from '../pdf/store.mjs';
import { VIDEO_BUCKET } from '../videoJobs.mjs';
import { planRoute, TASKS, DATA, recordUsage, estimateTokens, estimateCost } from '../aiRouter.mjs';
import { OUTPUT_TTL_DAYS } from './jobs.mjs';
import { createReplySecretGuard } from '../secretGuard.mjs';
import { secretEnvValues } from '../handoff.mjs';

export function jobGuard(env = process.env) {
  const g = createReplySecretGuard({ envValues: secretEnvValues(env), env });
  return (t) => g(String(t || '')).text;
}

export async function runJobTool(tool, args) {
  const fx = resolveTestFixture(tool, args);
  if (fx) {
    if (fx.type === 'result') return fx.result;
    throw Object.assign(new Error(fx.message || 'fixture error'), { code: fx.code || 'fixture_error' });
  }
  return runReadOnlyTool(tool, args, { identifier: 'a2a-job', licensed: true });
}

function headers(supKey, extra = {}) {
  return { apikey: supKey, Authorization: `Bearer ${supKey}`, ...extra };
}

export function outputStorage({ supUrl, supKey, fetchImpl = globalThis.fetch, env = process.env }) {
  return {
    async storeOutputs(job, out) {
      const artifacts = [];
      const path = `a2a/${job.id}/result.json`;
      const res = await fetchImpl(`${supUrl}/storage/v1/object/${VIDEO_BUCKET}/${path}`, { method: 'POST', headers: headers(supKey, { 'Content-Type': 'application/json', 'x-upsert': 'true' }), body: JSON.stringify(out.json) });
      if (!res.ok) throw Object.assign(new Error('could not store the result'), { code: 'storage_failed' });
      artifacts.push({ kind: 'json', path, name: `${job.job_type}-${job.id.slice(0, 8)}.json`, mime_type: 'application/json' });
      if (out.pdf) artifacts.push(out.pdf);
      return artifacts;
    },
    async makePdf(doc) {
      const made = await makeDocument({ doc, source: 'a2a', env, supUrl, supKey, fetchImpl, retentionDays: OUTPUT_TTL_DAYS });
      if (!made.ok || !made.card.stored) throw Object.assign(new Error(made.message || 'pdf failed'), { code: made.code || 'pdf_failed' });
      return { kind: 'pdf', path: `documents/${made.card.id}.pdf`, name: `${String(doc.title || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50)}.pdf`, mime_type: 'application/pdf', pages: made.card.pages };
    },
    async sign(artifact) {
      const res = await fetchImpl(`${supUrl}/storage/v1/object/sign/${VIDEO_BUCKET}/${artifact.path}`, { method: 'POST', headers: headers(supKey, { 'Content-Type': 'application/json' }), body: JSON.stringify({ expiresIn: OUTPUT_TTL_DAYS * 86400 }) });
      if (!res.ok) throw new Error('sign failed');
      const body = await res.json();
      const signed = body && (body.signedURL || body.signedUrl);
      const url = /^https:\/\//i.test(signed) ? signed : signed.startsWith('/storage/v1/') ? `${supUrl}${signed}` : `${supUrl}/storage/v1${signed.startsWith('/') ? '' : '/'}${signed}`;
      return `${url}${url.includes('?') ? '&' : '?'}download=${encodeURIComponent(artifact.name)}`;
    }
  };
}

// One write-up call: the reasoning core, then the paid main core. The
// spend is tracked for the job's cost. Customer data, so paid keys only
// (lib/aiRouter.mjs never routes DATA.CUSTOMER to the free key).
export function jobModel({ env = process.env, fetchImpl = globalThis.fetch, ledger = null, task = TASKS.HEAVY, maxTokens = 4000, usageTask = 'a2a_job' }) {
  let spent = 0;
  const write = async ({ system, prompt }) => {
    for (const c of planRoute(task, { env, dataClass: DATA.CUSTOMER })) {
      const model = c.models[0];
      try {
        if (c.family === 'anthropic') {
          const res = await fetchImpl('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': c.key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] }), signal: AbortSignal.timeout(40000) });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) continue;
          const text = (j.content || []).map((x) => x.text || '').join('');
          const u = j.usage || {};
          spent += estimateCost({ env, provider: 'anthropic', model, inputTokens: u.input_tokens || estimateTokens(system + prompt), outputTokens: u.output_tokens || estimateTokens(text) });
          recordUsage({ provider: 'anthropic', model, task: usageTask, dataClass: DATA.CUSTOMER, inputTokens: u.input_tokens, outputTokens: u.output_tokens, ok: !!text }, { env, ledger });
          if (text) return text;
        } else if (c.family === 'gemini' && c.provider === 'gemini_paid') {
          const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': c.key }, body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens } }), signal: AbortSignal.timeout(40000) });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) continue;
          const text = ((((j.candidates || [])[0] || {}).content || {}).parts || []).map((p) => p.text || '').join('');
          const u = j.usageMetadata || {};
          spent += estimateCost({ env, provider: 'gemini_paid', model, inputTokens: u.promptTokenCount || estimateTokens(system + prompt), outputTokens: u.candidatesTokenCount || estimateTokens(text) });
          recordUsage({ provider: 'gemini_paid', model, task: usageTask, dataClass: DATA.CUSTOMER, inputTokens: u.promptTokenCount, outputTokens: u.candidatesTokenCount, ok: !!text }, { env, ledger });
          if (text) return text;
        }
      } catch (e) { /* next candidate */ }
    }
    return null;
  };
  return { write, spent: () => spent };
}

// The Tool Foundry's purpose classifier (lib/foundry/screen.mjs): one cheap
// call on the paid light models.
export function foundryClassifierModel({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const m = jobModel({ env, fetchImpl, task: TASKS.LIGHT, maxTokens: 300, usageTask: 'foundry_screen' });
  return (args) => m.write(args);
}
