// check_package (1.16.0): a pre-install check for AI agents ("check before
// you install"). One npm or PyPI package per call; no AI model anywhere on
// this path, and nothing here imports one.
//
// Signals, each from a licence-checked public source (lib/attributions.mjs):
//   - exists?          the registry (npm public registry / PyPI JSON API).
//                      A missing package is a key signal: AI-invented names
//                      get registered by attackers later.
//   - age              first publish and latest-version publish dates, from
//                      the same registry answer.
//   - reported malicious  OSV MAL- advisories (OpenSSF Malicious Packages,
//                      Apache-2.0) via api.osv.dev, always worded "reported
//                      malicious": the source has false positives.
//   - vulnerabilities  OSV advisories for the version checked: ids and
//                      severity only, from the allow-listed databases.
//   - look-alike       the name against lib/popularPackages.mjs (separator
//                      swaps, digit/letter swaps, common prefixes and
//                      suffixes, edit distance). Local, no lookup.
//   - npm only         the version's deprecated flag and its install
//                      scripts (preinstall / install / postinstall).
//
// Status follows the PG1 rules (lib/responseMeta.mjs computeStatus): the
// reason codes decide. "flagged" for reported malicious, a package or
// version that does not exist, or a first publish under PACKAGE_NEW_DAYS
// days ago plus a look-alike name; otherwise "unknown" if any lookup did
// not complete; otherwise "no_flags". Never "safe" or "clean".
//
// Registry terms: one package per request, an identifying User-Agent,
// short timeouts, a size cap on the response, and caches (registry answers
// 1 hour, OSV answers - which carry malicious status - 15 minutes). Errors
// are never cached. A failed lookup is reported as such (exists: null,
// never false), so an outage can never read as "does not exist".
//
// Inputs are never stored: the caches are in memory, bounded, and hold
// only what the response needs. Errors carry fixed PG1-written text, never
// the caller's input or an upstream body.

import { withFixIt } from './invalidInput.mjs';
import { reason } from './reasonCodes.mjs';
import { buildCheck, withResponseMeta } from './responseMeta.mjs';
import { POPULAR_NPM_PACKAGES, POPULAR_PYPI_PACKAGES, POPULAR_PACKAGES_AS_OF } from './popularPackages.mjs';
import { ALLOWED_OSV_ID_PREFIXES, ATTRIBUTIONS_URL, PACKAGE_CHECK_ATTRIBUTION_TEXT } from './attributions.mjs';

export const PACKAGE_ECOSYSTEMS = Object.freeze(['npm', 'pypi']);
// "Very new": first published fewer than this many days ago. Same 30 days
// as check_domain_age's newly-registered threshold.
export const PACKAGE_NEW_DAYS = 30;

export const PACKAGE_REGISTRY_TIMEOUT_MS = 4000;
export const PACKAGE_OSV_TIMEOUT_MS = 4000;
export const PACKAGE_REGISTRY_CACHE_TTL_MS = 60 * 60 * 1000;
export const PACKAGE_OSV_CACHE_TTL_MS = 15 * 60 * 1000;
export const PACKAGE_CACHE_MAX_ENTRIES = 2000;
// Largest registry document read (decompressed). The biggest npm documents
// (packages with thousands of versions) are a few tens of MB; anything over
// this is reported as a failed lookup rather than read.
export const PACKAGE_REGISTRY_MAX_BYTES = 64 * 1024 * 1024;
export const PACKAGE_OSV_MAX_BYTES = 8 * 1024 * 1024;
// OSV pages followed per query; more than this and the answer is reported
// as incomplete.
export const PACKAGE_OSV_MAX_PAGES = 3;

export const NPM_REGISTRY_URL = 'https://registry.npmjs.org';
export const PYPI_JSON_URL = 'https://pypi.org/pypi';
export const OSV_QUERY_URL = 'https://api.osv.dev/v1/query';
export const PACKAGE_USER_AGENT = 'pg1-threat-intel/1.16.0 (check_package; +https://pg1-ai-agent.vercel.app/docs/attributions)';

// Generic checks[].source labels (never a vendor name).
export const PACKAGE_SOURCES = Object.freeze({
  registry: 'package registry',
  malicious: 'malicious package reports',
  vulnerabilities: 'vulnerability database',
  popular: 'popular package names'
});

const NPM_INSTALL_HOOKS = Object.freeze(['preinstall', 'install', 'postinstall']);
const MAX_NAME_LENGTH = 214;
const MAX_VERSION_LENGTH = 64;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Errors (MCP tool errors, isError: true). Fixed text; never the input.

class PackageInputError extends Error {
  constructor(code, fixIt) {
    super('');
    withFixIt(this, fixIt);
    this.name = 'PackageInputError';
    this.mcpToolError = true;
    this.code = code;
  }
}

function invalidEcosystem() {
  return new PackageInputError('invalid_ecosystem', { problem: 'ecosystem is missing or is not one of the supported package ecosystems', expected: '"npm" or "pypi"', example: 'npm' });
}

function invalidName(ecosystem, problem) {
  return new PackageInputError('invalid_package_name', ecosystem === 'pypi'
    ? { problem, expected: 'one PyPI project name: letters, digits, ".", "_" and "-", starting and ending with a letter or digit, at most 214 characters', example: 'requests' }
    : { problem, expected: 'one npm package name, optionally scoped (@scope/name): lowercase letters, digits, "-", ".", "_" and "~", not starting with "." or "_", at most 214 characters', example: 'lodash' });
}

function invalidVersion() {
  return new PackageInputError('invalid_version', { problem: 'version is not one exact version number', expected: 'one exact published version such as 4.17.21 (no ranges, tags or spaces), or omit it to check the latest version', example: '4.17.21' });
}

// ---------------------------------------------------------------------------
// Input

const NPM_NAME_RE = /^(?:@([a-z0-9][a-z0-9._~-]*)\/)?([a-z0-9~-][a-z0-9._~-]*)$/i;
const PYPI_NAME_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+!_-]*$/;

// PEP 503 normalisation: lowercase, runs of -, _ and . become one "-".
export function normalizePypiName(name) {
  return String(name).toLowerCase().replace(/[-_.]+/g, '-');
}

export function normalizeEcosystem(raw) {
  if (typeof raw !== 'string') throw invalidEcosystem();
  const eco = raw.trim().toLowerCase();
  if (!PACKAGE_ECOSYSTEMS.includes(eco)) throw invalidEcosystem();
  return eco;
}

// Returns { name, lookupName }: `name` as the caller gave it (trimmed), and
// the key the registry, the caches and the look-alike detector use.
export function normalizePackageName(ecosystem, raw) {
  if (typeof raw !== 'string') throw invalidName(ecosystem, 'name is missing or is not a string');
  const name = raw.trim();
  if (!name) throw invalidName(ecosystem, 'name is empty');
  if (name.length > MAX_NAME_LENGTH) throw invalidName(ecosystem, 'name is too long to be a package name');
  if (/[\s,;]/.test(name)) throw invalidName(ecosystem, 'name contains spaces or separators; send exactly one package per call');
  if (ecosystem === 'npm') {
    // Legacy npm names can carry capitals, and the registry is
    // case-sensitive, so the name is looked up exactly as given.
    if (!NPM_NAME_RE.test(name) || /^[._]/.test(name)) throw invalidName(ecosystem, 'name is not a valid npm package name');
    return { name, lookupName: name };
  }
  if (!PYPI_NAME_RE.test(name)) throw invalidName(ecosystem, 'name is not a valid PyPI project name');
  return { name, lookupName: normalizePypiName(name) };
}

export function normalizePackageVersion(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw invalidVersion();
  const version = raw.trim();
  if (!version) return null;
  if (version.length > MAX_VERSION_LENGTH || !VERSION_RE.test(version)) throw invalidVersion();
  return version;
}

export function normalizePackageInput(args) {
  const ecosystem = normalizeEcosystem(args?.ecosystem);
  const { name, lookupName } = normalizePackageName(ecosystem, args?.name);
  const version = normalizePackageVersion(args?.version);
  return { ecosystem, name, lookupName, version };
}

// ---------------------------------------------------------------------------
// Look-alike detection (local; no lookup)

const POPULAR = Object.freeze({
  npm: Object.freeze({ list: POPULAR_NPM_PACKAGES, set: new Set(POPULAR_NPM_PACKAGES) }),
  pypi: Object.freeze({ list: POPULAR_PYPI_PACKAGES, set: new Set(POPULAR_PYPI_PACKAGES) })
});

// Prefixes and suffixes commonly bolted onto a real name.
const AFFIXES = Object.freeze({
  npm: Object.freeze({ prefixes: ['node-', 'js-', 'npm-', 'the-', 'real-', 'official-'], suffixes: ['-js', '.js', 'js', '-node', '-npm', '-official', '-dev', '-lib', '-pkg', '2', '-2'] }),
  pypi: Object.freeze({ prefixes: ['python-', 'py-', 'py', 'python3-', 'the-', 'real-', 'official-'], suffixes: ['-python', '-py', 'py', '-python3', '3', '-official', '-dev', '-lib', '-pkg', '2', '-2'] })
});

const stripSeparators = (s) => s.replace(/[-_.]/g, '');

// Characters attackers swap for look-alike ones: digits for letters, "rn"
// for "m", "vv" for "w".
function confusableSkeleton(s) {
  return s.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/0/g, 'o').replace(/1/g, 'l').replace(/3/g, 'e').replace(/5/g, 's').replace(/4/g, 'a').replace(/7/g, 't');
}

// Optimal string alignment distance (Levenshtein plus adjacent swaps),
// stopping early once it exceeds `max`.
export function editDistance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows = [];
  for (let i = 0; i <= a.length; i++) rows.push(new Array(b.length + 1).fill(0));
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    rows[i][0] = i;
    let best = rows[i][0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, rows[i - 2][j - 2] + 1);
      rows[i][j] = v;
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
  }
  return rows[a.length][b.length];
}

// Returns { lookalike_of, pattern } or null. A popular name itself is never
// a look-alike. Patterns, strongest first: "separator" (the same name with
// "-", "_" or "." added, removed or swapped), "confusable" (digits or
// letter pairs swapped for look-alike ones), "affix" (a common prefix or
// suffix added), "edit_distance" (one typo, or two in a long name).
export function findLookalike(ecosystem, lookupName) {
  const popular = POPULAR[ecosystem];
  if (!popular) return null;
  const candidate = String(lookupName).toLowerCase();
  if (popular.set.has(candidate)) return null;
  const strippedC = stripSeparators(candidate);
  const skeletonC = confusableSkeleton(strippedC);
  const affixes = AFFIXES[ecosystem];

  let best = null;
  const consider = (match, pattern, rank, distance) => {
    if (!best || rank < best.rank || (rank === best.rank && distance < best.distance)) best = { lookalike_of: match, pattern, rank, distance };
  };

  for (const p of popular.list) {
    if (p.length < 3) continue;
    const strippedP = stripSeparators(p);
    if (strippedC === strippedP) { consider(p, 'separator', 0, 0); continue; }
    if (strippedP.length >= 4 && skeletonC === confusableSkeleton(strippedP)) { consider(p, 'confusable', 1, 0); continue; }
    if (p.length >= 4 && !p.startsWith('@') && (affixes.prefixes.some((x) => candidate === x + p) || affixes.suffixes.some((x) => candidate === p + x))) {
      consider(p, 'affix', 2, 0);
      continue;
    }
    if (p.length >= 5 && candidate.length >= 5) {
      const max = Math.min(p.length, candidate.length) >= 10 ? 2 : 1;
      const d = editDistance(candidate, p, max);
      if (d <= max) consider(p, 'edit_distance', 3, d);
    }
  }
  return best ? { lookalike_of: best.lookalike_of, pattern: best.pattern } : null;
}

// ---------------------------------------------------------------------------
// Caches (in memory, bounded, oldest entry first out). Errors never cached.

function createCache(ttlMs) {
  const map = new Map();
  return {
    get(key, now = Date.now()) {
      const entry = map.get(key);
      if (!entry) return null;
      if (now >= entry.expiresAt) { map.delete(key); return null; }
      return entry.value;
    },
    set(key, value, now = Date.now()) {
      map.delete(key);
      while (map.size >= PACKAGE_CACHE_MAX_ENTRIES) map.delete(map.keys().next().value);
      map.set(key, { value, expiresAt: now + ttlMs });
    },
    clear() { map.clear(); },
    size() { return map.size; }
  };
}

const registryCache = createCache(PACKAGE_REGISTRY_CACHE_TTL_MS);
const osvCache = createCache(PACKAGE_OSV_CACHE_TTL_MS);

export function __clearPackageCachesForTests() {
  registryCache.clear();
  osvCache.clear();
}

export function __packageCacheSizesForTests() {
  return { registry: registryCache.size(), osv: osvCache.size() };
}

// ---------------------------------------------------------------------------
// HTTP

let fetchImpl = (...args) => fetch(...args);

export function __setPackageFetchForTests(fn) {
  fetchImpl = fn || ((...args) => fetch(...args));
}

class LookupFailed extends Error {
  constructor(timedOut) {
    super(timedOut ? 'timed out' : 'failed');
    this.timedOut = timedOut;
  }
}

async function readCapped(res, maxBytes) {
  const declared = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN);
  if (Number.isFinite(declared) && declared > maxBytes) throw new LookupFailed(false);
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* already closed */ }
        throw new LookupFailed(false);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  }
  const text = await res.text();
  if (Buffer.byteLength(text) > maxBytes) throw new LookupFailed(false);
  return text;
}

// One request with a timeout covering the body too. Returns
// { status, json } (json null on 404), or throws LookupFailed.
async function requestJson(url, { method = 'GET', body = null, timeoutMs, maxBytes }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { Accept: 'application/json', 'User-Agent': PACKAGE_USER_AGENT };
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetchImpl(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal, redirect: 'follow' });
    if (res.status === 404) return { status: 404, json: null };
    if (!res.ok) throw new LookupFailed(false);
    const text = await readCapped(res, maxBytes);
    let json;
    try { json = JSON.parse(text); } catch { throw new LookupFailed(false); }
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new LookupFailed(false);
    return { status: res.status, json };
  } catch (err) {
    if (err instanceof LookupFailed) throw err;
    throw new LookupFailed(controller.signal.aborted || (err && err.name === 'AbortError'));
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Registries. Each parses its document down to the few facts the response
// needs; only that summary is cached.

function isoOrNull(v) {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function earliest(isos) {
  const ts = isos.filter(Boolean).map((s) => Date.parse(s)).filter((t) => !Number.isNaN(t));
  return ts.length ? new Date(Math.min(...ts)).toISOString() : null;
}

function cleanText(v, max = 300) {
  if (typeof v !== 'string') return null;
  // Control, zero-width and bidi-override characters go: this is publisher
  // text that ends up in chat cards and agent context.
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

export function parseNpmDocument(doc) {
  const versions = doc.versions && typeof doc.versions === 'object' ? doc.versions : {};
  const versionNames = Object.keys(versions);
  // A fully unpublished package has a document but no versions: nothing
  // can be installed, so it does not exist for this check.
  if (!versionNames.length) return { exists: false };
  const time = doc.time && typeof doc.time === 'object' ? doc.time : {};
  const latest = doc['dist-tags'] && typeof doc['dist-tags'].latest === 'string' ? doc['dist-tags'].latest : null;
  const deprecated = {};
  const installScripts = {};
  for (const [v, meta] of Object.entries(versions)) {
    if (!meta || typeof meta !== 'object') continue;
    if (typeof meta.deprecated === 'string' && meta.deprecated.trim()) deprecated[v] = cleanText(meta.deprecated);
    const scripts = meta.scripts && typeof meta.scripts === 'object' ? meta.scripts : {};
    const declared = (h) => typeof scripts[h] === 'string' && scripts[h].trim() !== '';
    // npm runs "node-gyp rebuild" as the install script of a package that
    // ships a binding.gyp and declares no install/preinstall of its own.
    const implicitGyp = meta.gypfile === true && !declared('install') && !declared('preinstall');
    const hooks = NPM_INSTALL_HOOKS.filter((h) => declared(h) || (h === 'install' && implicitGyp));
    if (hooks.length) installScripts[v] = hooks;
  }
  const versionTimes = versionNames.map((v) => isoOrNull(time[v]));
  return {
    exists: true,
    canonical_name: typeof doc.name === 'string' ? doc.name : null,
    versions: versionNames,
    latest_version: latest && versions[latest] ? latest : null,
    first_published: isoOrNull(time.created) || earliest(versionTimes),
    latest_published: latest ? isoOrNull(time[latest]) : null,
    deprecated,
    install_scripts: installScripts
  };
}

export function parsePypiDocument(doc) {
  const info = doc.info && typeof doc.info === 'object' ? doc.info : {};
  const releases = doc.releases && typeof doc.releases === 'object' ? doc.releases : {};
  const versionNames = Object.keys(releases);
  const uploadTimes = (files) => (Array.isArray(files) ? files : []).map((f) => isoOrNull(f && (f.upload_time_iso_8601 || f.upload_time)));
  const latest = typeof info.version === 'string' && info.version ? info.version : null;
  const latestFiles = latest && Array.isArray(releases[latest]) ? releases[latest] : (Array.isArray(doc.urls) ? doc.urls : []);
  return {
    exists: true,
    canonical_name: typeof info.name === 'string' ? info.name : null,
    versions: versionNames.length ? versionNames : (latest ? [latest] : []),
    latest_version: latest,
    first_published: earliest(versionNames.flatMap((v) => uploadTimes(releases[v]))) || earliest(uploadTimes(latestFiles)),
    latest_published: earliest(uploadTimes(latestFiles)),
    deprecated: null,
    install_scripts: null
  };
}

function npmPackageUrl(name) {
  // "@scope/name" -> "@scope%2Fname"
  return `${NPM_REGISTRY_URL}/${encodeURIComponent(name).replace(/^%40/, '@')}`;
}

// Returns { result: 'ok', data, cached, fetchedAt } or
// { result: 'timeout' | 'error' }.
export async function lookupRegistry(ecosystem, lookupName) {
  const key = `${ecosystem}:${lookupName}`;
  const hit = registryCache.get(key);
  if (hit) return { result: 'ok', data: hit.data, fetchedAt: hit.fetchedAt, cached: true };
  const url = ecosystem === 'npm' ? npmPackageUrl(lookupName) : `${PYPI_JSON_URL}/${encodeURIComponent(lookupName)}/json`;
  try {
    const { status, json } = await requestJson(url, { timeoutMs: PACKAGE_REGISTRY_TIMEOUT_MS, maxBytes: PACKAGE_REGISTRY_MAX_BYTES });
    const data = status === 404 ? { exists: false } : (ecosystem === 'npm' ? parseNpmDocument(json) : parsePypiDocument(json));
    const fetchedAt = new Date().toISOString();
    registryCache.set(key, { data, fetchedAt });
    return { result: 'ok', data, fetchedAt, cached: false };
  } catch (err) {
    return { result: err && err.timedOut ? 'timeout' : 'error' };
  }
}

// PEP 440-ish comparison key for matching a requested PyPI version against
// the published ones ("2.31" and "2.31.0" are the same release).
function pep440Key(v) {
  let s = String(v).trim().toLowerCase().replace(/^v/, '');
  const m = /^(\d+(?:\.\d+)*)(.*)$/.exec(s);
  if (m) s = m[1].replace(/(?:\.0)+$/, '') + m[2];
  return s;
}

// The published spelling of `requested`, or null when it is not published.
export function matchPublishedVersion(ecosystem, versions, requested) {
  if (!Array.isArray(versions)) return null;
  if (versions.includes(requested)) return requested;
  if (ecosystem === 'pypi') {
    const want = pep440Key(requested);
    return versions.find((v) => pep440Key(v) === want) || null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// OSV

const OSV_ECOSYSTEM = Object.freeze({ npm: 'npm', pypi: 'PyPI' });
const SEVERITY_LABELS = new Set(['LOW', 'MODERATE', 'MEDIUM', 'HIGH', 'CRITICAL']);

function allowedId(id) {
  return typeof id === 'string' && ALLOWED_OSV_ID_PREFIXES.some((p) => id.startsWith(p));
}

function severityOf(vuln) {
  const label = vuln.database_specific && typeof vuln.database_specific.severity === 'string' ? vuln.database_specific.severity.trim().toUpperCase() : null;
  const cvss = Array.isArray(vuln.severity) ? vuln.severity.find((s) => s && typeof s.score === 'string' && /^CVSS_V[34]$/.test(String(s.type || ''))) : null;
  return {
    severity: label && SEVERITY_LABELS.has(label) ? label : null,
    cvss_vector: cvss && /^CVSS:[34]\.\d\//.test(cvss.score) ? cvss.score.slice(0, 200) : null
  };
}

// Only ids and severity are kept from OSV: never summaries or details.
// Returns { malicious: [ids], vulnerabilities: [{ id, severity,
// cvss_vector }], omitted } for one query's advisories.
export function summarizeOsvVulns(vulns) {
  const malicious = [];
  const vulnerabilities = [];
  let omitted = 0;
  const seen = new Set();
  for (const v of Array.isArray(vulns) ? vulns : []) {
    if (!v || typeof v.id !== 'string' || seen.has(v.id)) continue;
    seen.add(v.id);
    if (!allowedId(v.id)) { omitted++; continue; }
    if (v.id.startsWith('MAL-')) malicious.push(v.id);
    else vulnerabilities.push({ id: v.id, ...severityOf(v) });
  }
  malicious.sort();
  vulnerabilities.sort((a, b) => a.id.localeCompare(b.id));
  return { malicious, vulnerabilities, omitted };
}

// One OSV query (package, plus version when given), following at most
// PACKAGE_OSV_MAX_PAGES pages. Returns { result: 'ok', ...summary,
// fetchedAt, cached } or { result: 'timeout' | 'error' }.
export async function queryOsv(ecosystem, lookupName, version) {
  const key = `${ecosystem}:${lookupName}@${version || '*'}`;
  const hit = osvCache.get(key);
  if (hit) return { result: 'ok', ...hit, cached: true };
  const pkg = { name: lookupName, ecosystem: OSV_ECOSYSTEM[ecosystem] };
  const all = [];
  let pageToken = null;
  try {
    for (let page = 0; ; page++) {
      if (page >= PACKAGE_OSV_MAX_PAGES) return { result: 'error' };
      const body = version ? { package: pkg, version } : { package: pkg };
      if (pageToken) body.page_token = pageToken;
      const { status, json } = await requestJson(OSV_QUERY_URL, { method: 'POST', body, timeoutMs: PACKAGE_OSV_TIMEOUT_MS, maxBytes: PACKAGE_OSV_MAX_BYTES });
      if (status === 404 || !json) return { result: 'error' };
      if (json.vulns !== undefined && !Array.isArray(json.vulns)) return { result: 'error' };
      all.push(...(json.vulns || []));
      pageToken = typeof json.next_page_token === 'string' && json.next_page_token ? json.next_page_token : null;
      if (!pageToken) break;
    }
  } catch (err) {
    return { result: err && err.timedOut ? 'timeout' : 'error' };
  }
  const value = { ...summarizeOsvVulns(all), fetchedAt: new Date().toISOString() };
  osvCache.set(key, value);
  return { result: 'ok', ...value, cached: false };
}

// ---------------------------------------------------------------------------
// The result

export const PACKAGE_NOTE = 'Signals for deciding whether to install, not a verdict on the package. "Reported malicious" means a public report exists; such reports can be false positives. A package that does not exist, or a very new package whose name looks like a popular one, is a common sign of a typosquat or of a name an AI assistant invented. No flags means nothing was found in the sources checked, not that installing is without risk.';

function ageDays(iso, nowMs) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((nowMs - t) / DAY_MS));
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Builds the response from the lookups. `registry`, `osv` are the
// lookupRegistry / queryOsv outcomes (osv null when no query ran);
// `osvScope` is 'version' (the query named the version checked) or
// 'package' (no version could be determined: package-level query).
export function buildPackageResult({ ecosystem, name, lookupName, version }, { registry, osv, osvScope, lookalike, nowMs = Date.now(), attributionText = PACKAGE_CHECK_ATTRIBUTION_TEXT }) {
  const reg = registry && registry.result === 'ok' ? registry.data : null;
  const exists = reg ? reg.exists === true : null;
  let versionChecked = null;
  let versionExists = null;
  if (reg && exists) {
    if (version) {
      versionChecked = matchPublishedVersion(ecosystem, reg.versions, version);
      versionExists = versionChecked !== null;
      if (!versionExists) versionChecked = version;
    } else {
      versionChecked = reg.latest_version;
      versionExists = reg.latest_version ? true : null;
    }
  } else if (version) {
    versionChecked = version;
    versionExists = reg ? false : null;
  }

  const firstPublished = reg && exists ? reg.first_published : null;
  const days = ageDays(firstPublished, nowMs);
  const veryNew = days !== null && days < PACKAGE_NEW_DAYS;

  const osvOk = osv && osv.result === 'ok';
  const malicious = osvOk ? osv.malicious : null;
  const vulnerabilities = osvOk && osvScope === 'version' ? osv.vulnerabilities : null;

  const npm = ecosystem === 'npm';
  const versionMeta = reg && exists && versionExists ? versionChecked : null;
  const deprecationMessage = npm && versionMeta && reg.deprecated ? (reg.deprecated[versionMeta] || null) : null;
  const deprecated = npm ? (versionMeta ? deprecationMessage !== null : null) : null;
  const installScripts = npm ? (versionMeta ? (reg.install_scripts[versionMeta] || []) : null) : null;

  const reasons = [];
  if (malicious && malicious.length) {
    reasons.push(reason('PACKAGE_REPORTED_MALICIOUS', osvScope === 'version'
      ? `This version is reported malicious in ${plural(malicious.length, 'public malicious-package report', 'public malicious-package reports')} (${malicious.join(', ')}). Such reports can be false positives.`
      : `This package is reported malicious in ${plural(malicious.length, 'public malicious-package report', 'public malicious-package reports')} (${malicious.join(', ')}). Such reports can be false positives.`));
  }
  if (exists === false) reasons.push(reason('PACKAGE_NOT_FOUND'));
  else if (exists && version && versionExists === false) reasons.push(reason('PACKAGE_VERSION_NOT_FOUND'));
  if (lookalike && veryNew && exists) {
    reasons.push(reason('PACKAGE_NEW_LOOKALIKE', `Package was first published ${days} day(s) ago and its name looks like the popular package "${lookalike.lookalike_of}".`));
  } else {
    if (lookalike) reasons.push(reason('PACKAGE_LOOKALIKE', `Package name looks like the popular package "${lookalike.lookalike_of}" (${lookalike.pattern.replace('_', ' ')}).`));
    if (veryNew && exists) reasons.push(reason('PACKAGE_NEWLY_PUBLISHED', `Package was first published ${days} day(s) ago.`));
  }
  if (vulnerabilities && vulnerabilities.length) reasons.push(reason('PACKAGE_KNOWN_VULNERABILITIES', `The version checked has ${plural(vulnerabilities.length, 'known vulnerability', 'known vulnerabilities')} in the advisory databases checked.`));
  if (deprecated) reasons.push(reason('PACKAGE_DEPRECATED'));
  if (installScripts && installScripts.length) reasons.push(reason('PACKAGE_INSTALL_SCRIPTS', `The version checked runs install scripts: ${installScripts.join(', ')}.`));

  const registryCheck = registry ? registry.result : 'skipped';
  const osvCheck = osv ? osv.result : 'skipped';
  const checks = [
    buildCheck(PACKAGE_SOURCES.registry, registryCheck, { dataAsOf: registry && registry.result === 'ok' ? registry.fetchedAt : null }),
    buildCheck(PACKAGE_SOURCES.malicious, osvCheck, { dataAsOf: osvOk ? osv.fetchedAt : null }),
    // Vulnerabilities are per version: with no version to check (the
    // package does not exist, or the registry did not answer and none was
    // given) this check is skipped. A skip makes status "unknown" unless a
    // warning (e.g. PACKAGE_NOT_FOUND) flags the result anyway.
    buildCheck(PACKAGE_SOURCES.vulnerabilities, osvScope === 'version' ? osvCheck : 'skipped', { dataAsOf: osvOk && osvScope === 'version' ? osv.fetchedAt : null }),
    buildCheck(PACKAGE_SOURCES.popular, 'ok', { dataAsOf: POPULAR_PACKAGES_AS_OF })
  ];

  return withResponseMeta({
    ecosystem,
    name,
    canonical_name: reg && exists ? (reg.canonical_name || lookupName) : null,
    version_requested: version,
    version_checked: versionChecked,
    exists,
    version_exists: versionExists,
    first_published: firstPublished,
    age_days: days,
    latest_version: reg && exists ? reg.latest_version : null,
    latest_published: reg && exists ? reg.latest_published : null,
    reported_malicious: malicious === null ? null : malicious.length > 0,
    malicious_reports: malicious,
    vulnerabilities,
    vulnerabilities_omitted: osvOk ? osv.omitted : 0,
    lookalike_of: lookalike ? lookalike.lookalike_of : null,
    lookalike_pattern: lookalike ? lookalike.pattern : null,
    deprecated,
    deprecation_message: deprecationMessage,
    install_scripts: installScripts,
    cached: !!(registry && registry.cached) && (!osv || !!osv.cached),
    note: PACKAGE_NOTE,
    attribution: { text: attributionText, url: ATTRIBUTIONS_URL }
  }, { reasons, checks });
}

// The whole check: lookups in the fewest round trips the inputs allow.
//   - version given: registry and OSV (that version) in parallel;
//   - no version: registry first, then OSV for its latest version;
//   - no version and the registry has none (not found or no answer): a
//     package-level OSV query, for malicious reports only.
export async function checkPackage(args, { nowMs } = {}) {
  const input = normalizePackageInput(args);
  const { ecosystem, lookupName, version } = input;
  const lookalike = findLookalike(ecosystem, lookupName);

  let registry;
  let osv;
  let osvScope;
  if (version) {
    [registry, osv] = await Promise.all([lookupRegistry(ecosystem, lookupName), queryOsv(ecosystem, lookupName, version)]);
    osvScope = 'version';
  } else {
    registry = await lookupRegistry(ecosystem, lookupName);
    const latest = registry.result === 'ok' && registry.data.exists ? registry.data.latest_version : null;
    if (latest) {
      osv = await queryOsv(ecosystem, lookupName, latest);
      osvScope = 'version';
    } else {
      osv = await queryOsv(ecosystem, lookupName, null);
      osvScope = 'package';
    }
  }
  return buildPackageResult(input, { registry, osv, osvScope, lookalike, nowMs: nowMs ?? Date.now() });
}

// Fixed pg1_errors reasons for lookups that did not complete, for the
// dispatchers to log under their own request_id. Never the input.
export function packageCheckFailureReasons(result) {
  const out = [];
  for (const c of (result && result.checks) || []) {
    if (c.result !== 'timeout' && c.result !== 'error') continue;
    const which = c.source === PACKAGE_SOURCES.registry ? 'registry' : c.source === PACKAGE_SOURCES.malicious ? 'osv' : null;
    if (!which) continue;
    out.push({ reason: `check_package_${which}_${c.result === 'timeout' ? 'timeout' : 'upstream_unavailable'}`, category: c.result === 'timeout' ? 'timeout' : 'upstream' });
  }
  return out;
}
