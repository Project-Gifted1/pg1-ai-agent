// Keeping the hosting dataset current (signed-in operator only):
//
//   /hosting status                    stale (> 180 days) and unverified facts
//   /hosting research <topic>          a lab research experiment; the runner
//                                      returns proposed updates, each with an
//                                      official source URL and the date checked
//   /hosting apply <experiment>        shows the proposed updates (the gate:
//                                      every update cites an https source and a
//                                      valid date, for a known field)
//   /hosting apply <experiment> confirm  writes them (APPROVAL: this command)
//   /hosting confirm <key> <field>     the operator checked a fact against its
//                                      source: marks it verified, dated today
//
// The lab's research comes from the web: it is data, never instructions,
// and nothing is written without the operator's confirm.

import { loadHostingData, createHostingStore, __clearHostingCache } from './store.mjs';
import { stalenessOf } from './advisor.mjs';
import { STALE_AFTER_DAYS } from './dataset.mjs';
import { startLabExperiment } from '../lab/chat.mjs';
import { createLabStore } from '../lab/store.mjs';
import { logAutonomy } from '../autonomy.mjs';

export const HOSTING_GOAL_PREFIX = '[hosting]';
export const UPDATE_FIELDS = Object.freeze({ jurisdiction: ['data_protection', 'eu_adequacy', 'government_access', 'sanctions'], provider: ['regions', 'sla', 'aup', 'dpa'] });
const MAX_UPDATES = 40;

export function isHostingCommand(text) {
  return /^\/hosting(?:\s|$)/i.test(String(text || '').trim());
}

function factsOf(data) {
  const out = [];
  for (const j of data.jurisdictions) {
    for (const field of ['data_protection', 'eu_adequacy', 'sanctions']) out.push({ key: j.code, field, fact: j[field] });
    (j.government_access || []).forEach((fct, i) => out.push({ key: j.code, field: `government_access[${i}]`, fact: fct }));
  }
  for (const p of data.providers) for (const field of ['regions', 'sla', 'aup', 'dpa']) out.push({ key: p.id, field, fact: p[field] });
  return out;
}

// The updates in a lab report: a fenced ```hosting_updates block holding a
// JSON array. Returns { updates, problems }.
export function parseHostingUpdates(markdown, { data, now = Date.now() } = {}) {
  const m = /```hosting_updates\s*\n([\s\S]*?)```/.exec(String(markdown || ''));
  if (!m) return { updates: [], problems: ['the report has no hosting_updates block'] };
  let list;
  try { list = JSON.parse(m[1]); } catch (e) { return { updates: [], problems: ['the hosting_updates block is not valid JSON'] }; }
  if (!Array.isArray(list)) return { updates: [], problems: ['hosting_updates must be a JSON array'] };
  const updates = [];
  const problems = [];
  const today = new Date(now).toISOString().slice(0, 10);
  for (const [i, u] of list.slice(0, MAX_UPDATES).entries()) {
    const where = `update ${i + 1}`;
    if (!u || !UPDATE_FIELDS[u.table]) { problems.push(`${where}: table must be jurisdiction or provider`); continue; }
    const exists = u.table === 'jurisdiction' ? data.jurisdictions.some((j) => j.code === u.key) : data.providers.some((p) => p.id === u.key);
    if (!exists) { problems.push(`${where}: unknown ${u.table} ${String(u.key).slice(0, 20)}`); continue; }
    if (!UPDATE_FIELDS[u.table].includes(u.field)) { problems.push(`${where}: ${u.field} is not an updatable field`); continue; }
    const items = u.field === 'government_access' ? (Array.isArray(u.value) ? u.value : null) : [u];
    if (!items) { problems.push(`${where}: government_access takes an array of { value, source_url }`); continue; }
    const bad = items.find((x) => !x || !/^https:\/\/[^\s]+$/i.test(String(x.source_url || '')));
    if (bad) { problems.push(`${where}: every fact needs an https source_url`); continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(u.checked_on || '')) || u.checked_on > today) { problems.push(`${where}: checked_on must be a date no later than today`); continue; }
    const fact = (x) => ({ value: x.value, source_url: x.source_url, checked_on: u.checked_on, verified: true, via: 'lab' });
    updates.push({ table: u.table, key: u.key, field: u.field, fact: u.field === 'government_access' ? items.map(fact) : fact(u) });
  }
  return { updates, problems };
}

const show = (v) => JSON.stringify(v && v.value !== undefined ? v.value : v).slice(0, 160);

export async function handleHostingCommand({ text, env = process.env, supUrl, supKey, fetchImpl = globalThis.fetch, isOperator = false, now = Date.now(), deps = {} }) {
  if (isOperator !== true) return { reply: 'Hosting dataset commands are for the signed-in operator only.' };
  const m = /^\/hosting\s*(\S*)\s*([\s\S]*)$/i.exec(String(text || '').trim());
  const sub = (m[1] || 'status').toLowerCase();
  const rest = (m[2] || '').trim();
  try {
    const data = await loadHostingData({ supUrl, supKey, fetchImpl, now });
    if (sub === 'status') {
      const facts = factsOf(data);
      const stale = facts.filter((x) => stalenessOf(x.fact, now).stale);
      const unverified = facts.filter((x) => stalenessOf(x.fact, now).unverified);
      return { reply: ['### [ HOSTING DATASET ]', `- Source: ${data.source} · ${data.jurisdictions.length} jurisdictions, ${data.providers.length} providers, ${facts.length} facts`, `- Stale (> ${STALE_AFTER_DAYS} days): ${stale.length}`, `- Unverified: ${unverified.length}`, ...unverified.slice(0, 8).map((x) => `  - ${x.key} ${x.field}: ${x.fact && x.fact.source_url}`), '', '/hosting confirm <key> <field> after checking a fact; /hosting research <topic> for a lab update.'].join('\n') };
    }
    if (sub === 'confirm') {
      const [key, field] = rest.split(/\s+/);
      const table = data.jurisdictions.some((j) => j.code === key) ? 'jurisdiction' : data.providers.some((p) => p.id === key) ? 'provider' : null;
      if (!table || !UPDATE_FIELDS[table].includes(field)) return { reply: 'Usage: /hosting confirm <jurisdiction code or provider id> <field>.' };
      if (data.source !== 'database') return { reply: 'The hosting tables are not set up yet (run the migration); nothing was changed.' };
      const store = deps.store || createHostingStore({ supUrl, supKey, fetchImpl });
      const row = await store.get(table, key);
      const day = new Date(now).toISOString().slice(0, 10);
      const confirmFact = (f) => ({ ...f, checked_on: day, verified: true, via: 'operator' });
      await store.setField(table, key, field, Array.isArray(row[field]) ? row[field].map(confirmFact) : confirmFact(row[field]));
      await logAutonomy({ supUrl, supKey, fetchImpl }, { action: 'hosting:apply', decision: 'allowed', mode: 'operator', outcome: 'confirmed', detail: `${key} ${field}` });
      return { reply: `${key} ${field} marked verified, checked ${day}.` };
    }
    if (sub === 'research') {
      if (!rest) return { reply: 'Usage: /hosting research <what to check, for example "EU adequacy decisions" or "Hetzner regions">.' };
      const start = deps.startLab || startLabExperiment;
      const out = await start({ env, supUrl, supKey, fetchImpl, kind: 'research', action: 'hosting:research', goal: `${HOSTING_GOAL_PREFIX} Check against official sources only (legislation sites, regulators, the providers' own pages): ${rest.slice(0, 300)}. End the report with a fenced block \`\`\`hosting_updates holding a JSON array of {"table":"jurisdiction"|"provider","key":"<code or id>","field":"<field>","value":<value>,"source_url":"https://...","checked_on":"YYYY-MM-DD"}, only for facts that changed or that you confirmed today.` });
      return { reply: out.reply };
    }
    if (sub === 'apply') {
      const [expId, confirm] = rest.split(/\s+/);
      const labStore = deps.labStore || createLabStore({ supUrl, supKey, fetchImpl });
      const exp = await labStore.get(expId);
      if (!exp || !String(exp.goal || '').startsWith(HOSTING_GOAL_PREFIX)) return { reply: `There is no hosting research experiment ${expId || '(no id)'}.` };
      if (exp.status !== 'done') return { reply: `Experiment ${exp.id.slice(0, 8)} is ${exp.status}; /lab status refreshes it.` };
      const { updates, problems } = parseHostingUpdates(exp.result && exp.result.report_markdown, { data, now });
      if (!updates.length) return { reply: ['No updates passed the gate.', ...problems.map((p) => `- ${p}`)].join('\n') };
      if (String(confirm || '').toLowerCase() !== 'confirm') {
        return { reply: ['### [ HOSTING UPDATES: REVIEW ]', 'Research from the web is data: check each source before confirming.', ...updates.map((u) => `- ${u.key} ${u.field} → ${show(Array.isArray(u.fact) ? u.fact.map((x) => x.value) : u.fact)} (${Array.isArray(u.fact) ? u.fact.map((x) => x.source_url).join(', ') : u.fact.source_url})`), ...(problems.length ? ['Skipped:', ...problems.map((p) => `- ${p}`)] : []), '', `/hosting apply ${exp.id.slice(0, 8)} confirm writes them.`].join('\n') };
      }
      if (data.source !== 'database') return { reply: 'The hosting tables are not set up yet (run the migration); nothing was changed.' };
      const store = deps.store || createHostingStore({ supUrl, supKey, fetchImpl });
      for (const u of updates) await store.setField(u.table, u.key, u.field, u.fact);
      __clearHostingCache();
      await logAutonomy({ supUrl, supKey, fetchImpl }, { action: 'hosting:apply', decision: 'allowed', mode: 'operator', outcome: 'applied', detail: `${updates.length} updates from experiment ${exp.id.slice(0, 8)}` });
      return { reply: `Applied ${updates.length} update${updates.length === 1 ? '' : 's'} from experiment ${exp.id.slice(0, 8)}.` };
    }
    return { reply: 'Hosting commands: /hosting status, /hosting research <topic>, /hosting apply <experiment> [confirm], /hosting confirm <key> <field>.' };
  } catch (e) {
    return { reply: 'The hosting dataset could not be read right now.' };
  }
}
