/**
 * PG1's fallback router (lib/router/chains.mjs, lib/router/alerts.mjs,
 * ROUTING_CHAINS in lib/capabilities/registry.mjs; docs/director-mode.md A):
 *
 *  - every chain is read from the registry, in the order the operator set;
 *  - only capacity failures fall through (credit, quota, 429, 5xx,
 *    timeout, missing key); a content-safety refusal or a bad request stops
 *    and the next engine is never asked;
 *  - client work uses only commercial_ok engines;
 *  - one capacity alert per engine per hour, shared through the database,
 *    naming the engine (operator-only).
 *
 * Run with: node --test tests/router-chains.test.mjs
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ROUTING_CHAINS, stepLicence, capability } from '../lib/capabilities/registry.mjs';
import { chainPlan, runChain, failureClass, FAILURE, CHAIN_IDS, emptyPlanReason } from '../lib/router/chains.mjs';
import { createCapacityAlerts, alertText, __resetAlerts, ALERT_WINDOW_MS } from '../lib/router/alerts.mjs';
import { notificationText } from '../lib/watches/push.mjs';
import { planRoute, TASKS, DATA, __resetRouterState, isTripped, isOutOfCredit, CREDIT_RECHECK_MS } from '../lib/aiRouter.mjs';
import { EngineError } from '../lib/film/providers.mjs';
import { makeFilmDb, filmDbRoutes, routedFetch } from './helpers/filmDb.mjs';

const ALL_KEYS = {
  ANTHROPIC_API_KEY: 'sk-ant-x', GEMINI_API_KEY_PAID: 'paid-x', GEMINI_API_KEY_FREE: 'free-x', OPENROUTER_API_KEY: 'or-x',
  REPLICATE_API_TOKEN: 'r8-x', CARTESIA_API_KEY: 'car-x', ELEVENLABS_API_KEY: 'el-x'
};
const order = (plan) => plan.steps.map((s) => `${s.provider}${s.slot ? `:${s.slot}` : ''}`);

beforeEach(() => { __resetRouterState(); __resetAlerts(); });

describe('chains as built', () => {
  test('the operator\'s chains, in order', () => {
    assert.deepEqual(order(chainPlan('text', { env: ALL_KEYS })), ['anthropic', 'gemini_paid', 'openrouter'], 'Claude -> Gemini -> next configured');
    assert.deepEqual(order(chainPlan('clips', { env: ALL_KEYS })), ['gemini_paid', 'replicate'], 'Gemini Omni -> Kling');
    assert.deepEqual(chainPlan('clips', { env: ALL_KEYS }).steps.map((s) => s.model), ['gemini-omni-1.1-flash', 'kwaivgi/kling-v2.1']);
    assert.deepEqual(chainPlan('stills', { env: ALL_KEYS }).steps.map((s) => s.model), ['black-forest-labs/flux-kontext-pro', 'gemini-3.1-flash-image'], 'FLUX Kontext Pro -> Gemini image');
    assert.deepEqual(order(chainPlan('voice', { env: ALL_KEYS })), ['elevenlabs', 'cartesia'], 'ElevenLabs brand voice -> Cartesia');
    assert.deepEqual(chainPlan('music', { env: ALL_KEYS }).steps.map((s) => s.model), ['lyria-3.5', 'lyria-3-clip-preview', 'Eleven Music'], 'Lyria 3.5 -> Lyria clip -> ElevenLabs');
    assert.deepEqual(chainPlan('music_film', { env: ALL_KEYS }).steps.map((s) => s.model), ['lyria-3.5', 'lyria-3-clip-preview'], 'ElevenLabs never for film without film rights');
    assert.deepEqual(chainPlan('music_film', { env: { ...ALL_KEYS, PG1_ELEVENLABS_FILM_RIGHTS: '1' } }).steps.map((s) => s.provider), ['gemini_paid', 'gemini_paid', 'elevenlabs']);
    assert.deepEqual(order(chainPlan('research', { env: ALL_KEYS })), ['gemini_paid', 'anthropic'], 'research: Gemini -> Claude');
    assert.ok(CHAIN_IDS.includes('dialogue') && CHAIN_IDS.includes('sfx') && CHAIN_IDS.includes('image'));
  });

  test('planRoute takes its order from the same chains', () => {
    const heavy = planRoute(TASKS.HEAVY, { env: ALL_KEYS, dataClass: DATA.CUSTOMER }).map((c) => c.provider);
    assert.deepEqual(heavy, ROUTING_CHAINS.text.map((s) => s.provider).filter((p) => heavy.includes(p)));
    assert.equal(heavy[0], 'anthropic');
    assert.ok(!heavy.includes('gemini_free'), 'customer data never goes to the free key');
    const light = planRoute(TASKS.LIGHT, { env: ALL_KEYS, dataClass: DATA.OPERATOR }).map((c) => c.provider);
    assert.deepEqual(light.slice(0, 3), ['gemini_free', 'gemini_paid', 'anthropic']);
  });

  test('a missing key, a provider over budget and the free key for customers are left out, with the reason', () => {
    const p = chainPlan('text', { env: { GEMINI_API_KEY_PAID: 'p', GEMINI_API_KEY_FREE: 'f', PG1_DAILY_BUDGET_GEMINI_PAID_USD: '0' } });
    assert.deepEqual(order(p), []);
    assert.deepEqual(Object.fromEntries(p.skipped.map((s) => [s.provider, s.reason])), { anthropic: 'no_key', gemini_paid: 'budget', gemini_free: 'operator_only', groq: 'operator_only', mistral: 'operator_only', github_models: 'operator_only', cloudflare: 'operator_only', openrouter: 'no_key', gateway: 'no_key', openai: 'no_key' });
    assert.match(emptyPlanReason(p), /over today's budget/);
    assert.deepEqual(order(chainPlan('text', { env: { GEMINI_API_KEY_FREE: 'f' }, operator: true })), ['gemini_free'], 'the operator\'s own text may use the free key');
  });
});

describe('licence: client work uses commercial_ok engines only', () => {
  test('Kling (R1) and Cartesia (C1) are skipped for a client film', () => {
    assert.equal(stepLicence(ROUTING_CHAINS.clips[1]), 'unclear');
    assert.equal(stepLicence(ROUTING_CHAINS.voice[1]), 'unclear');
    const clips = chainPlan('clips', { env: ALL_KEYS, clientWork: true });
    assert.deepEqual(clips.steps.map((s) => s.model), ['gemini-omni-1.1-flash']);
    assert.deepEqual(clips.skipped.map((s) => [s.model, s.reason]), [['kwaivgi/kling-v2.1', 'licence']]);
    assert.deepEqual(order(chainPlan('voice', { env: ALL_KEYS, clientWork: true })), ['elevenlabs']);
    assert.ok(chainPlan('text', { env: ALL_KEYS, clientWork: true, operator: true }).steps.every((s) => s.provider !== 'gemini_free'), 'never the free tier for a client');
    // With only the unlicensed engine configured: an empty plan and why.
    const kling = chainPlan('clips', { env: { REPLICATE_API_TOKEN: 'r8' }, clientWork: true });
    assert.equal(kling.steps.length, 0);
    assert.match(emptyPlanReason(kling, { clientWork: true }), /settled commercial licence/);
    // The operator's own film may use them.
    assert.deepEqual(chainPlan('clips', { env: { REPLICATE_API_TOKEN: 'r8' } }).steps.map((s) => s.provider), ['replicate']);
    // Every chain step's licence is the registry's own where it names a model.
    for (const [id, steps] of Object.entries(ROUTING_CHAINS)) for (const s of steps) if (s.feature) assert.ok(capability(s.feature).models.some((m) => m.model === s.model), `${id}: ${s.model} is in the registry`);
  });
});

describe('what falls through and what stops', () => {
  test('the classifier', () => {
    const cap = (o) => assert.equal(failureClass(o), FAILURE.CAPACITY, JSON.stringify(o));
    cap({ status: 402, text: 'Insufficient credit' });
    cap({ status: 429, text: 'Resource has been exhausted (e.g. check quota).' });
    cap({ status: 400, text: 'Your credit balance is too low to access the Anthropic API.' });
    cap({ status: 503, text: 'overloaded' });
    cap({ status: null, text: 'The operation was aborted' });
    cap({ status: 401, text: 'invalid api key' });
    cap({ kind: 'not_configured' });
    cap({ kind: 'timeout' });
    cap({ kind: 'throttled' });
    const stop = (o, cls) => assert.equal(failureClass(o), cls, JSON.stringify(o));
    stop({ status: 200, text: 'blocked: PROHIBITED_CONTENT', refused: true }, FAILURE.REFUSED);
    stop({ kind: 'refused' }, FAILURE.REFUSED);
    stop({ status: 400, text: 'Request blocked by safety filter' }, FAILURE.REFUSED);
    stop({ status: 400, text: 'invalid argument: aspect_ratio' }, FAILURE.ERROR);
  });

  const plan = () => chainPlan('clips', { env: ALL_KEYS });
  test('a capacity failure moves on, and trips the breaker', async () => {
    for (const failure of [
      { status: 402, detail: 'out of credit' }, { status: 429, detail: 'quota exceeded' }, { status: 500, detail: 'internal' },
      { status: null, kind: 'timeout', detail: 'timed out' }, { status: null, kind: 'not_configured', detail: 'no key' }
    ]) {
      __resetRouterState();
      const asked = [];
      const out = await runChain({ plan: plan(), attempt: async (s) => { asked.push(s.provider); return s.provider === 'gemini_paid' ? { ok: false, ...failure } : { ok: true, value: 'clip' }; } });
      assert.equal(out.ok, true, JSON.stringify(failure));
      assert.deepEqual(asked, ['gemini_paid', 'replicate']);
      assert.equal(out.step.provider, 'replicate');
      assert.equal(out.failures[0].cls, FAILURE.CAPACITY);
    }
    __resetRouterState();
    await runChain({ plan: plan(), attempt: async (s) => (s.provider === 'gemini_paid' ? { ok: false, status: 402, detail: 'out of credit' } : { ok: true }) });
    assert.ok(isTripped('gemini_paid'));
    assert.ok(isOutOfCredit('gemini_paid'), 'a drained engine is known to be out of credit');
    assert.deepEqual(order(plan()), ['replicate'], 'and left out of the next plans for an hour');
    assert.deepEqual(order(chainPlan('clips', { env: ALL_KEYS, now: Date.now() + CREDIT_RECHECK_MS + 1000 })), ['gemini_paid', 'replicate'], 'checked again after an hour');
  });

  test('a safety refusal STOPS: the next engine is never asked (an EngineError or a result)', async () => {
    for (const refusal of [
      () => { throw new EngineError('refused', 'the request was declined', { refused: true, detail: 'gemini clip blocked: PROHIBITED_CONTENT' }); },
      async () => ({ ok: false, status: 200, refused: true, detail: 'IMAGE_SAFETY' }),
      async () => ({ ok: false, kind: 'refused', detail: 'PG1 safety filter: a real artist\'s name' })
    ]) {
      const asked = [];
      const alerts = [];
      const out = await runChain({ plan: plan(), attempt: async (s) => { asked.push(s.provider); return refusal(); }, onCapacity: (a) => alerts.push(a) });
      assert.equal(out.ok, false);
      assert.equal(out.stopped, FAILURE.REFUSED);
      assert.deepEqual(asked, ['gemini_paid']);
      assert.equal(alerts.length, 0, 'a refusal is no capacity alert');
    }
  });

  test('a bad request stops too; every engine out of capacity ends "exhausted"', async () => {
    let asked = [];
    let out = await runChain({ plan: plan(), attempt: async (s) => { asked.push(s.provider); return { ok: false, status: 400, detail: 'invalid argument' }; } });
    assert.equal(out.stopped, FAILURE.ERROR);
    assert.deepEqual(asked, ['gemini_paid']);
    asked = [];
    const alerts = [];
    out = await runChain({ plan: plan(), attempt: async (s) => { asked.push(s.provider); return { ok: false, status: 429, detail: 'rate limited' }; }, onCapacity: (a) => alerts.push([a.step.provider, a.next && a.next.provider]) });
    assert.equal(out.stopped, 'exhausted');
    assert.deepEqual(asked, ['gemini_paid', 'replicate']);
    assert.deepEqual(alerts, [['gemini_paid', 'replicate'], ['replicate', null]]);
    assert.equal((await runChain({ plan: { steps: [], skipped: [] }, attempt: async () => ({ ok: true }) })).stopped, 'empty');
  });
});

describe('capacity alerts', () => {
  const store = { subscriptions: async () => [{ endpoint: 'https://push.test/x', keys: { p256dh: 'p', auth: 'a' } }] };
  const env = { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' };

  test('once per engine per hour, naming the engine; the database row is shared between processes', async () => {
    const db = await makeFilmDb();
    const fetchImpl = routedFetch(filmDbRoutes(db));
    const pushes = [];
    const push = async (p) => { pushes.push(p); return 1; };
    let t = Date.UTC(2026, 9, 16, 10);
    const a = createCapacityAlerts({ env, store, supUrl: 'https://supabase.test', supKey: 'k', fetchImpl, push, now: () => t });
    const b = createCapacityAlerts({ env, store, supUrl: 'https://supabase.test', supKey: 'k', fetchImpl, push, now: () => t });
    assert.equal((await a({ engine: 'replicate', kind: 'billing', what: 'clips', next: 'gemini_paid' })).sent, 1);
    assert.equal((await a({ engine: 'replicate', kind: 'throttled' })).claimed, false, 'the same engine again within the hour');
    __resetAlerts();
    assert.equal((await b({ engine: 'replicate', kind: 'billing' })).claimed, false, 'another process sees the database row');
    assert.equal((await b({ engine: 'cartesia', kind: 'timeout', what: 'the voice-over', next: null })).sent, 1, 'another engine alerts at once');
    assert.equal(pushes.length, 2);
    assert.equal(pushes[0].providerNames, true, 'operator-only: provider names allowed');
    assert.equal(pushes[0].title, 'Replicate is out of credit');
    assert.match(pushes[0].body, /PG1 router: Replicate is out of credit; clips moved to Gemini \(paid key\)\./);
    assert.match(pushes[1].body, /Cartesia timed out; no engine left for the voice-over/);
    // An hour later (the database's own clock): alerted again.
    await db.query("update public.pg1_router_alerts set last_sent = now() - interval '61 minutes' where engine = 'replicate'");
    t += ALERT_WINDOW_MS + 1000;
    __resetAlerts();
    assert.equal((await b({ engine: 'replicate', kind: 'billing' })).sent, 1);
  });

  test('without the database: once per process per hour', async () => {
    const pushes = [];
    let t = 0;
    const a = createCapacityAlerts({ env, store, push: async (p) => { pushes.push(p); return 1; }, now: () => t });
    await a({ engine: 'anthropic', kind: 'billing' });
    await a({ engine: 'anthropic', kind: 'billing' });
    t = ALERT_WINDOW_MS + 1;
    await a({ engine: 'anthropic', kind: 'billing' });
    assert.equal(pushes.length, 2);
  });

  test('the lock-screen text keeps the engine name for these alerts only', () => {
    const t = alertText({ engine: 'elevenlabs', status: 429, what: 'the voice-over', next: 'cartesia' });
    assert.equal(notificationText(t.body, 140, {}, { providerNames: true }), 'PG1 router: ElevenLabs is rate limited (429); the voice-over moved to Cartesia.');
    assert.doesNotMatch(notificationText(t.body, 140, {}), /ElevenLabs|Cartesia/, 'every other push stays white-label');
  });
});
