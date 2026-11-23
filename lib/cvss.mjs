// CVSS base scores from vectors, for check_package's advisory severity
// (lib/packageCheck.mjs). Pure; no network.
//
//   cvssBaseScore(vector)  -> { version: '3.0'|'3.1'|'4.0', score } | null
//   severityForScore(n)    -> 'NONE'|'LOW'|'MEDIUM'|'HIGH'|'CRITICAL'
//
// CVSS v3.x: the base equations of the CVSS v3.1 specification (FIRST),
// section 7.1, with its Roundup (Appendix A). v3.0 vectors use the same
// base equations.
//
// CVSS v4.0: the base score of the FIRST reference calculator
// (github.com/FIRSTdotorg/cvss-v4-calculator, cvss_score.js, cvss_lookup.js,
// max_composed.js, max_severity.js), ported to a module; the MacroVector
// lookup table and maxima below are copied from it unchanged. Threat and
// environmental metrics absent from a vector take the calculator's
// defaults (E:X as A; CR, IR, AR :X as H), so a base vector gets its base
// score (CVSS-B).
//
// The v4.0 parts are under this notice (BSD-2-Clause):
//   Copyright (c) 2023 FIRST.ORG, Inc., Red Hat, and contributors
//   Redistribution and use in source and binary forms, with or without
//   modification, are permitted provided that the following conditions are
//   met: 1. Redistributions of source code must retain the above copyright
//   notice, this list of conditions and the following disclaimer.
//   2. Redistributions in binary form must reproduce the above copyright
//   notice, this list of conditions and the following disclaimer in the
//   documentation and/or other materials provided with the distribution.
//   THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS
//   IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED
//   TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A
//   PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
//   HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
//   SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED
//   TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
//   PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
//   LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
//   NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
//   SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

export function severityForScore(n) {
  if (!Number.isFinite(n)) return null;
  if (n === 0) return 'NONE';
  if (n < 4) return 'LOW';
  if (n < 7) return 'MEDIUM';
  if (n < 9) return 'HIGH';
  return 'CRITICAL';
}

function parseMetrics(vector, prefix) {
  const parts = String(vector || '').trim().split('/');
  if (!parts.length || !prefix.test(parts[0])) return null;
  const out = {};
  for (const p of parts.slice(1)) {
    const m = /^([A-Z]+):([A-Z])$/.exec(p);
    if (!m || Object.hasOwn(out, m[1])) return null;
    out[m[1]] = m[2];
  }
  return out;
}

// --- CVSS v3.x -------------------------------------------------------------------------------
const V3 = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }, AC: { L: 0.77, H: 0.44 }, UI: { N: 0.85, R: 0.62 },
  CIA: { H: 0.56, L: 0.22, N: 0 }
};
// Roundup (CVSS v3.1 Appendix A): the smallest number, to one decimal, >= the input.
function roundup(x) { const i = Math.round(x * 100000); return i % 10000 === 0 ? i / 100000 : (Math.floor(i / 10000) + 1) / 10; }
function v3Score(m) {
  for (const k of ['AV', 'AC', 'PR', 'UI', 'S', 'C', 'I', 'A']) if (!m[k]) return null;
  const changed = m.S === 'C'; if (!changed && m.S !== 'U') return null;
  const av = V3.AV[m.AV]; const ac = V3.AC[m.AC]; const ui = V3.UI[m.UI];
  const pr = m.PR === 'N' ? 0.85 : m.PR === 'L' ? (changed ? 0.68 : 0.62) : m.PR === 'H' ? (changed ? 0.5 : 0.27) : undefined;
  const c = V3.CIA[m.C]; const i = V3.CIA[m.I]; const a = V3.CIA[m.A];
  if ([av, ac, ui, pr, c, i, a].some((x) => x === undefined)) return null;
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss;
  const exploitability = 8.22 * av * ac * pr * ui;
  if (impact <= 0) return 0;
  return changed ? roundup(Math.min(1.08 * (impact + exploitability), 10)) : roundup(Math.min(impact + exploitability, 10));
}

// --- CVSS v4.0 (FIRST reference calculator) -------------------------------------------------
const LOOKUP = Object.freeze({
  '000000': 10,
  '000001': 9.9,
  '000010': 9.8,
  '000011': 9.5,
  '000020': 9.5,
  '000021': 9.2,
  '000100': 10,
  '000101': 9.6,
  '000110': 9.3,
  '000111': 8.7,
  '000120': 9.1,
  '000121': 8.1,
  '000200': 9.3,
  '000201': 9,
  '000210': 8.9,
  '000211': 8,
  '000220': 8.1,
  '000221': 6.8,
  '001000': 9.8,
  '001001': 9.5,
  '001010': 9.5,
  '001011': 9.2,
  '001020': 9,
  '001021': 8.4,
  '001100': 9.3,
  '001101': 9.2,
  '001110': 8.9,
  '001111': 8.1,
  '001120': 8.1,
  '001121': 6.5,
  '001200': 8.8,
  '001201': 8,
  '001210': 7.8,
  '001211': 7,
  '001220': 6.9,
  '001221': 4.8,
  '002001': 9.2,
  '002011': 8.2,
  '002021': 7.2,
  '002101': 7.9,
  '002111': 6.9,
  '002121': 5,
  '002201': 6.9,
  '002211': 5.5,
  '002221': 2.7,
  '010000': 9.9,
  '010001': 9.7,
  '010010': 9.5,
  '010011': 9.2,
  '010020': 9.2,
  '010021': 8.5,
  '010100': 9.5,
  '010101': 9.1,
  '010110': 9,
  '010111': 8.3,
  '010120': 8.4,
  '010121': 7.1,
  '010200': 9.2,
  '010201': 8.1,
  '010210': 8.2,
  '010211': 7.1,
  '010220': 7.2,
  '010221': 5.3,
  '011000': 9.5,
  '011001': 9.3,
  '011010': 9.2,
  '011011': 8.5,
  '011020': 8.5,
  '011021': 7.3,
  '011100': 9.2,
  '011101': 8.2,
  '011110': 8,
  '011111': 7.2,
  '011120': 7,
  '011121': 5.9,
  '011200': 8.4,
  '011201': 7,
  '011210': 7.1,
  '011211': 5.2,
  '011220': 5,
  '011221': 3,
  '012001': 8.6,
  '012011': 7.5,
  '012021': 5.2,
  '012101': 7.1,
  '012111': 5.2,
  '012121': 2.9,
  '012201': 6.3,
  '012211': 2.9,
  '012221': 1.7,
  '100000': 9.8,
  '100001': 9.5,
  '100010': 9.4,
  '100011': 8.7,
  '100020': 9.1,
  '100021': 8.1,
  '100100': 9.4,
  '100101': 8.9,
  '100110': 8.6,
  '100111': 7.4,
  '100120': 7.7,
  '100121': 6.4,
  '100200': 8.7,
  '100201': 7.5,
  '100210': 7.4,
  '100211': 6.3,
  '100220': 6.3,
  '100221': 4.9,
  '101000': 9.4,
  '101001': 8.9,
  '101010': 8.8,
  '101011': 7.7,
  '101020': 7.6,
  '101021': 6.7,
  '101100': 8.6,
  '101101': 7.6,
  '101110': 7.4,
  '101111': 5.8,
  '101120': 5.9,
  '101121': 5,
  '101200': 7.2,
  '101201': 5.7,
  '101210': 5.7,
  '101211': 5.2,
  '101220': 5.2,
  '101221': 2.5,
  '102001': 8.3,
  '102011': 7,
  '102021': 5.4,
  '102101': 6.5,
  '102111': 5.8,
  '102121': 2.6,
  '102201': 5.3,
  '102211': 2.1,
  '102221': 1.3,
  '110000': 9.5,
  '110001': 9,
  '110010': 8.8,
  '110011': 7.6,
  '110020': 7.6,
  '110021': 7,
  '110100': 9,
  '110101': 7.7,
  '110110': 7.5,
  '110111': 6.2,
  '110120': 6.1,
  '110121': 5.3,
  '110200': 7.7,
  '110201': 6.6,
  '110210': 6.8,
  '110211': 5.9,
  '110220': 5.2,
  '110221': 3,
  '111000': 8.9,
  '111001': 7.8,
  '111010': 7.6,
  '111011': 6.7,
  '111020': 6.2,
  '111021': 5.8,
  '111100': 7.4,
  '111101': 5.9,
  '111110': 5.7,
  '111111': 5.7,
  '111120': 4.7,
  '111121': 2.3,
  '111200': 6.1,
  '111201': 5.2,
  '111210': 5.7,
  '111211': 2.9,
  '111220': 2.4,
  '111221': 1.6,
  '112001': 7.1,
  '112011': 5.9,
  '112021': 3,
  '112101': 5.8,
  '112111': 2.6,
  '112121': 1.5,
  '112201': 2.3,
  '112211': 1.3,
  '112221': 0.6,
  '200000': 9.3,
  '200001': 8.7,
  '200010': 8.6,
  '200011': 7.2,
  '200020': 7.5,
  '200021': 5.8,
  '200100': 8.6,
  '200101': 7.4,
  '200110': 7.4,
  '200111': 6.1,
  '200120': 5.6,
  '200121': 3.4,
  '200200': 7,
  '200201': 5.4,
  '200210': 5.2,
  '200211': 4,
  '200220': 4,
  '200221': 2.2,
  '201000': 8.5,
  '201001': 7.5,
  '201010': 7.4,
  '201011': 5.5,
  '201020': 6.2,
  '201021': 5.1,
  '201100': 7.2,
  '201101': 5.7,
  '201110': 5.5,
  '201111': 4.1,
  '201120': 4.6,
  '201121': 1.9,
  '201200': 5.3,
  '201201': 3.6,
  '201210': 3.4,
  '201211': 1.9,
  '201220': 1.9,
  '201221': 0.8,
  '202001': 6.4,
  '202011': 5.1,
  '202021': 2,
  '202101': 4.7,
  '202111': 2.1,
  '202121': 1.1,
  '202201': 2.4,
  '202211': 0.9,
  '202221': 0.4,
  '210000': 8.8,
  '210001': 7.5,
  '210010': 7.3,
  '210011': 5.3,
  '210020': 6,
  '210021': 5,
  '210100': 7.3,
  '210101': 5.5,
  '210110': 5.9,
  '210111': 4,
  '210120': 4.1,
  '210121': 2,
  '210200': 5.4,
  '210201': 4.3,
  '210210': 4.5,
  '210211': 2.2,
  '210220': 2,
  '210221': 1.1,
  '211000': 7.5,
  '211001': 5.5,
  '211010': 5.8,
  '211011': 4.5,
  '211020': 4,
  '211021': 2.1,
  '211100': 6.1,
  '211101': 5.1,
  '211110': 4.8,
  '211111': 1.8,
  '211120': 2,
  '211121': 0.9,
  '211200': 4.6,
  '211201': 1.8,
  '211210': 1.7,
  '211211': 0.7,
  '211220': 0.8,
  '211221': 0.2,
  '212001': 5.3,
  '212011': 2.4,
  '212021': 1.4,
  '212101': 2.4,
  '212111': 1.2,
  '212121': 0.5,
  '212201': 1,
  '212211': 0.3,
  '212221': 0.1
});
const MAX_COMPOSED = Object.freeze({
  eq1: { 0: ['AV:N/PR:N/UI:N/'], 1: ['AV:A/PR:N/UI:N/', 'AV:N/PR:L/UI:N/', 'AV:N/PR:N/UI:P/'], 2: ['AV:P/PR:N/UI:N/', 'AV:A/PR:L/UI:P/'] },
  eq2: { 0: ['AC:L/AT:N/'], 1: ['AC:H/AT:N/', 'AC:L/AT:P/'] },
  eq3: {
    0: { 0: ['VC:H/VI:H/VA:H/CR:H/IR:H/AR:H/'], 1: ['VC:H/VI:H/VA:L/CR:M/IR:M/AR:H/', 'VC:H/VI:H/VA:H/CR:M/IR:M/AR:M/'] },
    1: { 0: ['VC:L/VI:H/VA:H/CR:H/IR:H/AR:H/', 'VC:H/VI:L/VA:H/CR:H/IR:H/AR:H/'], 1: ['VC:L/VI:H/VA:L/CR:H/IR:M/AR:H/', 'VC:L/VI:H/VA:H/CR:H/IR:M/AR:M/', 'VC:H/VI:L/VA:H/CR:M/IR:H/AR:M/', 'VC:H/VI:L/VA:L/CR:M/IR:H/AR:H/', 'VC:L/VI:L/VA:H/CR:H/IR:H/AR:M/'] },
    2: { 1: ['VC:L/VI:L/VA:L/CR:H/IR:H/AR:H/'] }
  },
  eq4: { 0: ['SC:H/SI:S/SA:S/'], 1: ['SC:H/SI:H/SA:H/'], 2: ['SC:L/SI:L/SA:L/'] },
  eq5: { 0: ['E:A/'], 1: ['E:P/'], 2: ['E:U/'] }
});
const MAX_SEVERITY = Object.freeze({
  eq1: { 0: 1, 1: 4, 2: 5 }, eq2: { 0: 1, 1: 2 }, eq3eq6: { 0: { 0: 7, 1: 6 }, 1: { 0: 8, 1: 8 }, 2: { 1: 10 } }, eq4: { 0: 6, 1: 5, 2: 4 }, eq5: { 0: 1, 1: 1, 2: 1 }
});
const LEVELS = {
  AV: { N: 0, A: 0.1, L: 0.2, P: 0.3 }, PR: { N: 0, L: 0.1, H: 0.2 }, UI: { N: 0, P: 0.1, A: 0.2 }, AC: { L: 0, H: 0.1 }, AT: { N: 0, P: 0.1 },
  VC: { H: 0, L: 0.1, N: 0.2 }, VI: { H: 0, L: 0.1, N: 0.2 }, VA: { H: 0, L: 0.1, N: 0.2 },
  SC: { H: 0.1, L: 0.2, N: 0.3 }, SI: { S: 0, H: 0.1, L: 0.2, N: 0.3 }, SA: { S: 0, H: 0.1, L: 0.2, N: 0.3 },
  CR: { H: 0, M: 0.1, L: 0.2 }, IR: { H: 0, M: 0.1, L: 0.2 }, AR: { H: 0, M: 0.1, L: 0.2 }
};
const V4_BASE = { AV: 'NALP', AC: 'LH', AT: 'NP', PR: 'NLH', UI: 'NPA', VC: 'HLN', VI: 'HLN', VA: 'HLN', SC: 'HLN', SI: 'HLN', SA: 'HLN' };

// The metric value the calculator scores with (its m()).
function mv(sel, metric) {
  const s = sel[metric];
  if (metric === 'E' && (s === undefined || s === 'X')) return 'A';
  if ((metric === 'CR' || metric === 'IR' || metric === 'AR') && (s === undefined || s === 'X')) return 'H';
  const mod = sel[`M${metric}`];
  if (mod !== undefined && mod !== 'X') return mod;
  return s;
}
function extract(metric, str) { const rest = str.slice(str.indexOf(metric) + metric.length + 1); const k = rest.indexOf('/'); return k > 0 ? rest.slice(0, k) : rest; }

function macroVector(sel) {
  const g = (k) => mv(sel, k);
  const eq1 = g('AV') === 'N' && g('PR') === 'N' && g('UI') === 'N' ? 0 : (g('AV') === 'N' || g('PR') === 'N' || g('UI') === 'N') && g('AV') !== 'P' ? 1 : 2;
  const eq2 = g('AC') === 'L' && g('AT') === 'N' ? 0 : 1;
  const eq3 = g('VC') === 'H' && g('VI') === 'H' ? 0 : g('VC') === 'H' || g('VI') === 'H' || g('VA') === 'H' ? 1 : 2;
  const eq4 = g('MSI') === 'S' || g('MSA') === 'S' ? 0 : g('SC') === 'H' || g('SI') === 'H' || g('SA') === 'H' ? 1 : 2;
  const eq5 = g('E') === 'A' ? 0 : g('E') === 'P' ? 1 : 2;
  const eq6 = (g('CR') === 'H' && g('VC') === 'H') || (g('IR') === 'H' && g('VI') === 'H') || (g('AR') === 'H' && g('VA') === 'H') ? 0 : 1;
  return `${eq1}${eq2}${eq3}${eq4}${eq5}${eq6}`;
}

function v4Score(sel) {
  for (const [k, allowed] of Object.entries(V4_BASE)) if (!sel[k] || !allowed.includes(sel[k])) return null;
  if (['VC', 'VI', 'VA', 'SC', 'SI', 'SA'].every((k) => mv(sel, k) === 'N')) return 0;
  const mac = macroVector(sel);
  let value = LOOKUP[mac];
  if (value === undefined) return null;
  const [eq1, eq2, eq3, eq4, eq5, eq6] = [...mac].map(Number);
  const at = (a, b, c, d, e, f) => LOOKUP[`${a}${b}${c}${d}${e}${f}`];
  const s1 = at(eq1 + 1, eq2, eq3, eq4, eq5, eq6);
  const s2 = at(eq1, eq2 + 1, eq3, eq4, eq5, eq6);
  let s36;
  if (eq3 === 1 && eq6 === 1) s36 = at(eq1, eq2, eq3 + 1, eq4, eq5, eq6);
  else if (eq3 === 0 && eq6 === 1) s36 = at(eq1, eq2, eq3 + 1, eq4, eq5, eq6);
  else if (eq3 === 1 && eq6 === 0) s36 = at(eq1, eq2, eq3, eq4, eq5, eq6 + 1);
  else if (eq3 === 0 && eq6 === 0) { const l = at(eq1, eq2, eq3, eq4, eq5, eq6 + 1); const r = at(eq1, eq2, eq3 + 1, eq4, eq5, eq6); s36 = l > r ? l : r; }
  else s36 = at(eq1, eq2, eq3 + 1, eq4, eq5, eq6 + 1);
  const s4 = at(eq1, eq2, eq3, eq4 + 1, eq5, eq6);
  const s5 = at(eq1, eq2, eq3, eq4, eq5 + 1, eq6);
  const maxes = [];
  for (const a of MAX_COMPOSED.eq1[eq1]) for (const b of MAX_COMPOSED.eq2[eq2]) for (const c of MAX_COMPOSED.eq3[eq3][eq6]) for (const d of MAX_COMPOSED.eq4[eq4]) for (const e of MAX_COMPOSED.eq5[eq5]) maxes.push(a + b + c + d + e);
  let dist = null;
  for (const mx of maxes) {
    const d = {};
    for (const k of Object.keys(LEVELS)) d[k] = LEVELS[k][mv(sel, k)] - LEVELS[k][extract(k, mx)];
    dist = d;
    if (Object.values(d).some((x) => x < 0)) continue;
    break;
  }
  const cur1 = dist.AV + dist.PR + dist.UI;
  const cur2 = dist.AC + dist.AT;
  const cur36 = dist.VC + dist.VI + dist.VA + dist.CR + dist.IR + dist.AR;
  const cur4 = dist.SC + dist.SI + dist.SA;
  const step = 0.1;
  const avail = [value - s1, value - s2, value - s36, value - s4, value - s5];
  const maxSev = [MAX_SEVERITY.eq1[eq1] * step, MAX_SEVERITY.eq2[eq2] * step, MAX_SEVERITY.eq3eq6[eq3][eq6] * step, MAX_SEVERITY.eq4[eq4] * step];
  const cur = [cur1, cur2, cur36, cur4];
  let n = 0; let sum = 0;
  for (let k = 0; k < 5; k++) {
    if (Number.isNaN(avail[k])) continue;
    n++;
    if (k < 4) sum += avail[k] * (cur[k] / maxSev[k]);
  }
  value -= n === 0 ? 0 : sum / n;
  if (value < 0) value = 0;
  if (value > 10) value = 10;
  return Math.round(value * 10) / 10;
}

export function cvssBaseScore(vector) {
  const v = String(vector || '').trim();
  const m3 = /^CVSS:3\.([01])\//.exec(v);
  if (m3) { const m = parseMetrics(v, /^CVSS:3\.[01]$/); const score = m ? v3Score(m) : null; return score === null ? null : { version: `3.${m3[1]}`, score }; }
  if (/^CVSS:4\.0\//.test(v)) { const m = parseMetrics(v, /^CVSS:4\.0$/); const score = m ? v4Score(m) : null; return score === null ? null : { version: '4.0', score }; }
  return null;
}
