// Writes docs/studio-sound-phase1.md from the capability registry and the
// package estimates, so the report never drifts from the code:
//   node scripts/capabilities-report.mjs
// tests/capabilities.test.mjs fails when the file is stale.

import { writeFileSync } from 'node:fs';
import { REGISTRY, LICENCE_QUESTIONS, NOT_OFFERED, REGISTRY_VERSION } from '../lib/capabilities/registry.mjs';
import { offerability } from '../lib/capabilities/offers.mjs';
import { estimateFilmCost, estimateFilmStorage, PACKAGE_GRID, STORAGE_OPTIONS, storageMonthlyUsd, ASSUMPTIONS, BITRATE_SOURCES, PIPELINE_MAX_SECONDS } from '../lib/capabilities/costs.mjs';

const esc = (s) => String(s == null ? '-' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const usd = (n) => (n == null ? 'unknown' : n >= 1 ? `${n.toFixed(2)} USD` : `${Number(n.toFixed(4))} USD`);
const links = (urls) => (urls || []).map((u, i) => `[${i + 1}](${u})`).join(' ');
const OFFER_TEXT = { offer: 'may be offered', on_request: 'custom, on request', review: 'not offered (licence review)', never: 'never offered' };

export function reportMarkdown() {
  const out = [];
  out.push('# PG1 Studio + Sound: Phase 1 research and capability registry', '');
  out.push(`Registry version ${REGISTRY_VERSION}. Generated from \`lib/capabilities/registry.mjs\` and \`lib/capabilities/costs.mjs\` by \`node scripts/capabilities-report.mjs\`; edit those, not this file.`, '');
  out.push('**How the figures were gathered.** The research ran on 2026-10-14 through web-search extracts of official provider pages and model cards. This session\'s network policy blocked loading the pages themselves, so every figure marked *official* is unverified until checked on the live page, and where pages disagreed the dearer figure is used. Figures marked *PG1 estimate* are PG1\'s own. No figure here comes from a third-party blog or a search redirect link.', '');

  out.push('## 1. Capability registry', '');
  out.push('| Feature | Status | Chosen model(s) | Licence | Unit cost | Min price (1.5x) | Offer rule |');
  out.push('|---|---|---|---|---|---|---|');
  for (const e of REGISTRY) {
    const models = e.models.map((m) => `${m.model} (${m.provider}, ${m.role})`).join('; ') || '-';
    const lic = e.licence === 'unclear' ? `**unclear** (${e.review.join(', ') || 'no provider'})` : e.licence;
    const cost = e.unitCost.usd == null ? `unknown per ${e.unitCost.unit}` : `${usd(e.unitCost.usd)} per ${e.unitCost.unit} (${e.unitCost.basis === 'official' ? 'official' : 'PG1 estimate'})`;
    const min = e.minPrice.usd == null ? 'after a priced test' : `${usd(e.minPrice.usd)} per ${e.minPrice.unit}`;
    out.push(`| ${esc(e.feature)} | ${e.status}${e.gatedUntil ? ` (gated: ${e.gatedUntil})` : ''} | ${esc(models)} | ${lic} | ${esc(cost)} | ${esc(min)} | ${OFFER_TEXT[offerability(e)]} |`);
  }
  out.push('', `Never offered in this phase: ${NOT_OFFERED.map((n) => `${n.label}${n.never ? ' (never, in any phase)' : ''}`).join(', ')}.`, '');

  out.push('## 2. Research by feature', '');
  for (const e of REGISTRY) {
    out.push(`### ${e.feature}`, '');
    if (e.wired) out.push(`Wired now: ${e.wired}.`, '');
    if (e.note) out.push(e.note, '');
    if (e.unitCost.note) out.push(`Unit cost: ${e.unitCost.note}`, '');
    if (e.licenceConditions.length) out.push(`Licence conditions: ${e.licenceConditions.join(' ')}`, '');
    if (e.consent) {
      out.push('Consent and verification by provider:', '');
      for (const [p, t] of Object.entries(e.consent)) out.push(`- **${p}**: ${t}`);
      out.push('');
    }
    if (e.candidates.length) {
      out.push('| Provider | Model | What it does | Max resolution / length | Price | Licence, resale | Sources |');
      out.push('|---|---|---|---|---|---|---|');
      for (const c of e.candidates) out.push(`| ${esc(c.provider)} | ${esc(c.model)} | ${esc(c.does)} | ${esc(c.max)} | ${esc(c.price)} | ${esc(c.licence)}${c.note ? `; ${esc(c.note)}` : ''} | ${links(c.sources)} |`);
      out.push('');
    }
  }

  out.push('## 3. Open licence questions (for your review)', '');
  out.push('Every feature marked **unclear** is treated as not commercial: PG1 does not offer it to clients until the question is answered and the registry is changed.', '');
  for (const [code, q] of Object.entries(LICENCE_QUESTIONS)) {
    const blocks = REGISTRY.filter((e) => e.review.includes(code)).map((e) => e.feature);
    out.push(`- **${code}. ${q.question}** ${q.detail} Blocks: ${blocks.join('; ') || 'none'}. ${links(q.sources)}`);
  }
  out.push('');

  out.push('## 4. Compute cost per film package (PG1 estimates)', '');
  out.push(`Assumptions: ${ASSUMPTIONS.shotSeconds}-second shots, ${ASSUMPTIONS.shotsPerScene} shots a scene, ${ASSUMPTIONS.voiceCharsPerMinute} voice-over characters a minute, a quarter of shots retried once, PG1 Studio\'s own price table (lib/film/cost.mjs) for stills, checks, voice and music, the registry\'s clip rates (1080p 0.15 USD/s; 4K generated natively at about 0.30 USD/s, unconfirmed), and render time on a GitHub runner at ${ASSUMPTIONS.runnerUsdPerMinute} USD a minute. A 4K upscale of a 1080p film instead has no known price (registry: upscale_4k).`, '');
  out.push('| Film | Resolution | Shots | Clips | Everything else | Expected cost | Min price (1.5x) | One film in today\'s pipeline? |');
  out.push('|---|---|---|---|---|---|---|---|');
  for (const g of PACKAGE_GRID) {
    const c = estimateFilmCost(g);
    const clips = c.lines.find((l) => /^Video clips/.test(l.label)).usd + c.lines.find((l) => l.label === 'Expected retries').usd;
    out.push(`| ${g.minutes} min | ${g.resolution} | ${c.shots} | ${usd(clips)} | ${usd(Math.round((c.expectedUsd - clips) * 100) / 100)} | ${usd(c.expectedUsd)} | ${usd(c.minPriceUsd)} | ${c.fitsPipeline ? 'yes' : `no: over ${PIPELINE_MAX_SECONDS} s (30 shots of at most 10 s)`} |`);
  }
  out.push('', 'Clips (with retries) are 89-95% of every package\'s cost, so the clip rate decides the price. A 3-minute film fits today only with longer shots (18 shots of 10 s); its estimate above uses 5-second shots, which is the dearer case.', '');

  out.push('## 5. Storage per package (PG1 estimates)', '');
  out.push(`Video at ${ASSUMPTIONS.videoMbps['1080p']} Mbps (1080p) and ${ASSUMPTIONS.videoMbps['4k']} Mbps (4K) H.264, from YouTube\'s published rates ${links(BITRATE_SOURCES)}; audio at uncompressed WAV sizes, stems as FLAC at about ${Math.round(ASSUMPTIONS.flacShareOfWav * 100)}% of WAV.`, '');
  out.push('| Film | Resolution | Final film | Stems (4 x FLAC) | 5.1 WAV | 7.1 WAV | Client deliverables | With working files (clips, stills) |');
  out.push('|---|---|---|---|---|---|---|---|');
  for (const g of PACKAGE_GRID) {
    const s = estimateFilmStorage(g);
    const mb = (re) => s.items.find((i) => re.test(i.label)).mb;
    const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(2)} GB` : `${n} MB`);
    out.push(`| ${g.minutes} min | ${g.resolution} | ${fmt(mb(/^Final film/))} | ${fmt(mb(/stems/))} | ${fmt(mb(/^5\.1/))} | ${fmt(mb(/^7\.1/))} | ${fmt(s.clientMb)} | ${fmt(s.totalMb)} |`);
  }
  out.push('');

  out.push('## 6. Storage options for large video', '');
  out.push('| Option | Storage | Egress | Included / minimums | Notes | 500 GB stored, 1 TB served a month | 2 TB stored, 4 TB served | Source |');
  out.push('|---|---|---|---|---|---|---|---|');
  for (const o of STORAGE_OPTIONS) {
    out.push(`| ${esc(o.name)} | ${o.storagePerGbMonth} USD/GB-month | ${o.egressPerGb ? `${o.egressPerGb} USD/GB` : 'free'} | ${esc(o.included)} | ${esc(o.notes)} | ${usd(storageMonthlyUsd(o, { gb: 500, egressGb: 1000 }))} | ${usd(storageMonthlyUsd(o, { gb: 2000, egressGb: 4000 }))} | [1](${o.source}) |`);
  }
  out.push('', 'Monthly figures leave out per-request fees and Supabase\'s 25 USD plan fee.', '');
  out.push('**Recommendation: Cloudflare R2** for finished films, stems and mixes, with Supabase kept for the database and small files. Clients download large files, and R2 never charges for that, so the bill is storage alone and predictable: about 15 USD per TB-month. Supabase, by contrast, is 0.09 USD per GB served past 250 GB, so 4 TB served a month costs about 340 USD in egress alone. PG1 already has an R2 bucket bound in `wrangler.toml` (`pg1-storage`), and R2 is S3-compatible, so signed download links work like today\'s. Backblaze B2 is cheaper to store, but its egress is free only up to 3x the stored data or through a CDN partner, which adds a moving part. Wasabi needs a 1 TB minimum and 90-day minimum storage. Nothing has been set up.', '');

  out.push('## 7. Proposed scope for Phases 2-5', '');
  out.push(PHASES);
  return out.join('\n') + '\n';
}

const PHASES = [
  '**Phase 2: pipeline features.** Raise the film limits so 10-minute films fit: more shots, or a film built from chapters. Then wire, as custom on request:',
  '- 4K output, generated natively or upscaled, whichever has a confirmed price and licence;',
  '- frame interpolation (ffmpeg minterpolate);',
  '- sound effects (ElevenLabs);',
  '- multi-voice dialogue (once E2 is answered);',
  '- 5.1/7.1 mixes from stems (ffmpeg).',
  '',
  'Each feature moves to standard in the registry only when it is wired and tested. Move large deliverables to R2. Settle G1, G2, R1, E1 and C1 first; until then, pin client work to ElevenLabs for music, which stops the Lyria fallbacks making client tracks.',
  '',
  '**Phase 3: client accounts.** Per-client projects, deliverable history and signed download pages on R2, with no seats or account managers until you decide otherwise. The registry gains the account features, and the guard starts allowing them.',
  '',
  '**Phase 4: consented voice cloning.** Own-voice cloning only, through ElevenLabs Professional Voice Cloning with its voice captcha, on a Creator or higher plan. PG1 keeps its own consent record (who, when, which sample, the verification result) and offers deletion on request. PG1 Sound\'s refusal of all voice cloning is lifted only for verified own-voice clones. Then add 4 to SHIPPED_PHASES.',
  '',
  '**Phase 5: support agent.** A client-facing assistant that answers from the registry, the client\'s own projects and the published terms. It cannot change prices, licences or deliverables, and it hands anything else to the operator.',
  '',
  'IP indemnification and exclusive rights stay out in every phase.'
].join('\n');

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = new URL('../docs/studio-sound-phase1.md', import.meta.url);
  writeFileSync(out, reportMarkdown());
  console.log(`wrote ${out.pathname}`);
}
