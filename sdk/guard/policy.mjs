// pg1-guard policy: decides, for one proposed tool call, whether it runs
// (allow), waits for a person (ask) or is stopped (block), and why.
//
// A policy is plain JSON (default-policy.json is the starting point):
//
//   default   'allow' | 'ask' | 'block'   what happens when no rule matches
//   tools     { block: [glob], ask: [glob], allow: [glob] }  by tool name
//   money     { tools: [glob], amount_fields: [name], max_per_call,
//               max_per_day, always_ask }  tools that move money
//   network   { allow_domains, block_domains, block_private_addresses,
//               https_only }  for every URL or host found in the arguments
//   secrets   { block_in_arguments }  keys, tokens, private keys
//   rate      { per_tool_per_minute }
//
// Order: any block reason wins, then any ask reason, then an explicit
// allow, then the default. Nothing here moves money on its own: with
// money.always_ask (the default) every money tool waits for a person, and
// an amount over a limit is blocked outright. Evaluation is pure apart
// from the rate and spend counters kept in `state`.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DECISIONS = ['allow', 'ask', 'block'];

export function loadDefaultPolicy() {
  return JSON.parse(readFileSync(fileURLToPath(new URL('./default-policy.json', import.meta.url)), 'utf8'));
}

// Merges a partial policy over the default, one level deep per section.
export function resolvePolicy(policy = {}) {
  const base = loadDefaultPolicy();
  const out = { ...base, ...policy };
  for (const k of ['tools', 'money', 'network', 'secrets', 'rate']) out[k] = { ...(base[k] || {}), ...((policy && policy[k]) || {}) };
  if (!DECISIONS.includes(out.default)) throw new Error(`policy.default must be one of ${DECISIONS.join(', ')}`);
  return out;
}

// '*' matches any run of characters; matching ignores case.
export function globMatch(pattern, name) {
  const re = new RegExp('^' + String(pattern).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return re.test(String(name));
}
const anyMatch = (list, name) => (Array.isArray(list) ? list : []).some((p) => globMatch(p, name));

// --- secrets -------------------------------------------------------------

const SECRET_PATTERNS = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['cloud access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['API key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['payment secret key', /\b(sk|rk)_live_[A-Za-z0-9]{16,}\b/],
  ['code host token', /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ['chat app token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['signed token', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ['seed phrase', /\b(seed|mnemonic|recovery)[_ -]?(phrase|words)?\s*[=:]\s*(?:[a-z]+\s+){11,}[a-z]+/i],
  ['credential in a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
  ['labelled secret', /\b(api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{12,}/i]
];

export function findSecrets(value) {
  const found = new Set();
  for (const s of strings(value)) for (const [label, re] of SECRET_PATTERNS) if (re.test(s)) found.add(label);
  return [...found];
}

// Replaces anything that looks like a secret with [withheld], for logs.
export function redact(value) {
  if (typeof value === 'string') {
    let s = value;
    for (const [, re] of SECRET_PATTERNS) s = s.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'), '[withheld]');
    return s;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /^(api[_-]?key|secret|token|password|passwd|private[_-]?key|seed|mnemonic)$/i.test(k) && v ? '[withheld]' : redact(v)]));
  return value;
}

function* strings(value, depth = 0) {
  if (depth > 8 || value == null) return;
  if (typeof value === 'string') yield value;
  else if (Array.isArray(value)) for (const v of value) yield* strings(v, depth + 1);
  else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) { yield `${k}=${typeof v === 'string' ? v : ''}`; yield* strings(v, depth + 1); }
}

// --- network -------------------------------------------------------------

const URL_RE = /\b(?:https?|ftp|wss?|file):\/\/[^\s"'<>]+/gi;

// Every URL in the arguments, plus bare hosts and addresses given in fields
// named like one (host, hostname, domain, endpoint, ip, server, url), so
// "10.0.0.5" in a host field is checked like https://10.0.0.5/.
const HOST_KEY = /^(host|hostname|domain|endpoint|ip|address_ip|server|url|uri|base_?url)$/i;
const BARE_HOST = /^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+\.[a-z]{2,}|localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:\/.*)?$/i;

export function findUrls(value) {
  const out = [];
  for (const s of strings(value)) for (const m of s.matchAll(URL_RE)) out.push(m[0]);
  const visit = (v, depth) => {
    if (depth > 8 || v == null || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'string' && HOST_KEY.test(k) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(x.trim()) && BARE_HOST.test(x.trim())) out.push(`https://${x.trim()}`);
      else if (x && typeof x === 'object') visit(x, depth + 1);
    }
  };
  visit(value, 0);
  return [...new Set(out)];
}

function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h === 'metadata.google.internal') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (h.includes(':')) return h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h.startsWith('::ffff:');
  return false;
}

const domainIn = (host, list) => (Array.isArray(list) ? list : []).some((d) => { const x = String(d).toLowerCase().replace(/^\*\./, ''); return host === x || host.endsWith('.' + x); });

function networkReasons(urls, net) {
  const block = [];
  for (const raw of urls) {
    let u;
    try { u = new URL(raw); } catch { block.push({ rule: 'network.invalid_url', detail: `could not read the address ${raw.slice(0, 80)}` }); continue; }
    const host = u.hostname.toLowerCase();
    if (net.https_only && !['https:', 'wss:'].includes(u.protocol)) block.push({ rule: 'network.https_only', detail: `${u.protocol.replace(':', '')} address ${host} (only https is allowed)` });
    if (net.block_private_addresses && isPrivateHost(host)) block.push({ rule: 'network.private_address', detail: `private or internal address ${host}` });
    if (domainIn(host, net.block_domains)) block.push({ rule: 'network.block_domains', detail: `${host} is on the blocked list` });
    if (Array.isArray(net.allow_domains) && net.allow_domains.length && !domainIn(host, net.allow_domains)) block.push({ rule: 'network.allow_domains', detail: `${host} is not on the allowed list` });
  }
  return block;
}

// --- money ---------------------------------------------------------------

export function findAmount(args, fields) {
  let best = null;
  const visit = (v, depth) => {
    if (depth > 6 || v == null || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if ((fields || []).some((f) => f.toLowerCase() === k.toLowerCase())) {
        const n = typeof x === 'number' ? x : typeof x === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(x) ? Number(x) : NaN;
        if (Number.isFinite(n)) best = best == null ? n : Math.max(best, n);
      } else visit(x, depth + 1);
    }
  };
  visit(args, 0);
  return best;
}

// --- evaluate ------------------------------------------------------------

export function newState() {
  return { calls: new Map(), spentByDay: new Map() };
}

const dayKey = (now) => new Date(now).toISOString().slice(0, 10);

// Returns { decision, reasons: [{rule, detail}], money: { amount } | null }.
export function evaluate(policy, action, state = newState(), now = Date.now()) {
  const p = policy;
  const tool = String(action && action.tool || '');
  const args = action && action.args && typeof action.args === 'object' ? action.args : {};
  const block = [];
  const ask = [];
  let allow = false;

  if (!tool) block.push({ rule: 'tools.name', detail: 'the action names no tool' });
  if (anyMatch(p.tools.block, tool)) block.push({ rule: 'tools.block', detail: `${tool} is on the blocked list` });
  if (anyMatch(p.tools.ask, tool)) ask.push({ rule: 'tools.ask', detail: `${tool} needs a person's approval` });
  if (anyMatch(p.tools.allow, tool)) allow = true;

  if (p.secrets.block_in_arguments) {
    const s = findSecrets(args);
    if (s.length) block.push({ rule: 'secrets', detail: `the arguments contain what looks like a secret (${s.join(', ')})` });
  }

  block.push(...networkReasons(findUrls(args), p.network));

  const perMin = Number(p.rate.per_tool_per_minute);
  if (perMin > 0) {
    const recent = (state.calls.get(tool) || []).filter((t) => now - t < 60_000);
    if (recent.length >= perMin) block.push({ rule: 'rate', detail: `${tool} ran ${recent.length} times in the last minute (limit ${perMin})` });
  }

  let money = null;
  if (anyMatch(p.money.tools, tool)) {
    const amount = findAmount(args, p.money.amount_fields);
    money = { amount };
    const perCall = p.money.max_per_call;
    const perDay = p.money.max_per_day;
    const spent = state.spentByDay.get(dayKey(now)) || 0;
    if (amount == null) ask.push({ rule: 'money.amount', detail: 'a money action with no readable amount' });
    else {
      if (perCall != null && amount > perCall) block.push({ rule: 'money.max_per_call', detail: `amount ${amount} is over the per-call limit of ${perCall}` });
      if (perDay != null && spent + amount > perDay) block.push({ rule: 'money.max_per_day', detail: `amount ${amount} would take today's total to ${spent + amount}, over the daily limit of ${perDay}` });
    }
    if (p.money.always_ask) ask.push({ rule: 'money.always_ask', detail: 'money never moves without a person\'s approval' });
  }

  if (block.length) return { decision: 'block', reasons: block, money };
  if (ask.length) return { decision: 'ask', reasons: ask, money };
  if (allow) return { decision: 'allow', reasons: [{ rule: 'tools.allow', detail: `${tool} is on the allowed list` }], money };
  return { decision: p.default, reasons: [{ rule: 'default', detail: `no rule matched; the policy default is ${p.default}` }], money };
}

// Counts a call that actually ran (and the money it moved) against the
// rate and spend limits.
export function record(state, action, result, now = Date.now()) {
  const tool = String(action && action.tool || '');
  const list = (state.calls.get(tool) || []).filter((t) => now - t < 60_000);
  list.push(now);
  state.calls.set(tool, list);
  if (result && result.money && Number.isFinite(result.money.amount)) {
    const k = dayKey(now);
    state.spentByDay.set(k, (state.spentByDay.get(k) || 0) + result.money.amount);
  }
}
