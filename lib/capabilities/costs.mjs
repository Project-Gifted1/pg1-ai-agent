// Phase 1 package estimates: compute cost and storage size of a PG1 Studio
// film at a given length and resolution, from the same price tables PG1
// Studio charges against a film's cap (lib/film/cost.mjs) and the
// capability registry. ESTIMATES: every assumption below is PG1's own and
// is labelled so wherever these figures are shown.

import { FILM_PRICES, EXPECTED_RETRY_SHARE, musicCostUsd } from '../film/cost.mjs';
import { MAX_SHOTS, MAX_SHOT_S } from '../film/storyboard.mjs';
import { capability, minPrice } from './registry.mjs';

export const ASSUMPTIONS = Object.freeze({
  shotSeconds: 5,              // PG1 Studio's default clip length
  shotsPerScene: 4,
  voiceCharsPerMinute: 900,    // about 150 spoken words a minute
  runnerUsdPerMinute: 0.006,   // GitHub Linux 2-core (registry source github_runner_pricing)
  renderRunnerMinutesPerFilmMinute: Object.freeze({ '1080p': 3, '4k': 10 }),
  // Delivery bitrates: YouTube's recommended upload rate for 1080p SDR at
  // 24-30 fps (8 Mbps), and its recommended H.264 4K30 live-ingest rate
  // (42 Mbps; the upload page gives no 4K SDR figure).
  videoMbps: Object.freeze({ '1080p': 8, '4k': 42 }),
  audioKbps: 384,
  stillMb: 1.5,
  storyboardPdfMb: 1,
  flacShareOfWav: 0.55
});

export const BITRATE_SOURCES = Object.freeze([
  'https://support.google.com/youtube/answer/1722171?hl=en',
  'https://support.google.com/youtube/answer/2853702?hl=en'
]);

// The longest film the current pipeline makes in one piece.
export const PIPELINE_MAX_SECONDS = MAX_SHOTS * MAX_SHOT_S;

const round2 = (n) => Math.round(n * 100) / 100;
const round1 = (n) => Math.round(n * 10) / 10;

// USD per second of clip at a resolution: the dearest engine that could
// make it, as PG1 Studio reserves it. 4K is generated natively (Gemini
// Omni's 4K rate, unconfirmed); upscaling 1080p to 4K has no known price.
export function clipUsdPerSecond(resolution) {
  const v = capability('text_image_to_video').byResolution;
  if (resolution === '4k') return v['4k'].usd;
  return v['1080p'].usd;
}

// { minutes, resolution, fitsPipeline, lines: [{ label, count, usd }],
//   expectedUsd, minPriceUsd }
export function estimateFilmCost({ minutes, resolution = '1080p' }) {
  const seconds = Math.round(minutes * 60);
  const shots = Math.ceil(seconds / ASSUMPTIONS.shotSeconds);
  const scenes = Math.ceil(shots / ASSUMPTIONS.shotsPerScene);
  const clipShot = clipUsdPerSecond(resolution) * ASSUMPTIONS.shotSeconds;
  const voiceChars = Math.round(minutes * ASSUMPTIONS.voiceCharsPerMinute);
  const retries = Math.ceil(shots * EXPECTED_RETRY_SHARE);
  const runner = minutes * ASSUMPTIONS.renderRunnerMinutesPerFilmMinute[resolution] * ASSUMPTIONS.runnerUsdPerMinute;
  const lines = [
    { label: 'Storyboard', count: 1, usd: FILM_PRICES.storyboardUsd },
    { label: 'Reference still', count: 1, usd: FILM_PRICES.stillUsd },
    { label: 'Shot stills', count: shots, usd: shots * FILM_PRICES.stillUsd },
    { label: `Video clips (${resolution})`, count: shots, usd: shots * clipShot },
    { label: 'Shot checks', count: shots, usd: shots * FILM_PRICES.qcUsd },
    { label: 'Voice-over', count: voiceChars, usd: voiceChars * FILM_PRICES.voicePerCharUsd },
    { label: 'Music beds', count: scenes, usd: scenes * musicCostUsd() },
    { label: 'Final audio check', count: 1, usd: seconds * FILM_PRICES.transcribePerSecondUsd },
    { label: 'Expected retries', count: retries, usd: retries * (clipShot + FILM_PRICES.qcUsd + FILM_PRICES.stillUsd) },
    { label: 'Render runner', count: 1, usd: runner }
  ].map((l) => ({ ...l, usd: round2(l.usd) }));
  const expectedUsd = round2(lines.reduce((s, l) => s + l.usd, 0));
  return { minutes, resolution, seconds, shots, scenes, fitsPipeline: seconds <= PIPELINE_MAX_SECONDS, lines, expectedUsd, minPriceUsd: minPrice(expectedUsd) };
}

const mbFor = (mbps, seconds) => (mbps * 1e6 / 8) * seconds / 1e6;

// The deliverables of a film package and their sizes in MB.
export function estimateFilmStorage({ minutes, resolution = '1080p', stems = true, surround = true }) {
  const seconds = Math.round(minutes * 60);
  const shots = Math.ceil(seconds / ASSUMPTIONS.shotSeconds);
  const vMbps = ASSUMPTIONS.videoMbps[resolution];
  const wavStereoMbPerMin = (44100 * 2 * 2 * 60) / 1e6;
  const items = [
    { label: `Final film (${resolution} H.264, ${vMbps} Mbps, AAC ${ASSUMPTIONS.audioKbps} kbps)`, mb: mbFor(vMbps + ASSUMPTIONS.audioKbps / 1000, seconds), client: true },
    { label: 'Shot clips kept for edits (incl. expected retries)', mb: mbFor(vMbps, seconds * (1 + EXPECTED_RETRY_SHARE)), client: false },
    { label: 'Shot stills and the reference', mb: (shots + 1) * ASSUMPTIONS.stillMb, client: false },
    { label: 'Storyboard PDF', mb: ASSUMPTIONS.storyboardPdfMb, client: true }
  ];
  if (stems) items.push({ label: 'Music and dialogue stems (4 x FLAC stereo, 44.1 kHz/16-bit)', mb: 4 * wavStereoMbPerMin * ASSUMPTIONS.flacShareOfWav * minutes, client: true });
  if (surround) {
    items.push({ label: '5.1 mix (WAV, 48 kHz/24-bit, 6 channels)', mb: (6 * 48000 * 3 * 60 / 1e6) * minutes, client: true });
    items.push({ label: '7.1 mix (WAV, 48 kHz/24-bit, 8 channels)', mb: (8 * 48000 * 3 * 60 / 1e6) * minutes, client: true });
  }
  const out = items.map((i) => ({ ...i, mb: round1(i.mb) }));
  return {
    minutes, resolution, items: out,
    clientMb: round1(out.filter((i) => i.client).reduce((s, i) => s + i.mb, 0)),
    totalMb: round1(out.reduce((s, i) => s + i.mb, 0))
  };
}

export const PACKAGE_GRID = Object.freeze([1, 3, 10].flatMap((minutes) => ['1080p', '4k'].map((resolution) => Object.freeze({ minutes, resolution }))));

// Storage options for large video, per GB-month and per GB of egress (USD),
// from each provider's pricing page (search extracts, 2026-10-14).
export const STORAGE_OPTIONS = Object.freeze([
  Object.freeze({ id: 'cloudflare_r2', name: 'Cloudflare R2 (Standard)', storagePerGbMonth: 0.015, egressPerGb: 0, included: '10 GB-month, 1M Class A and 10M Class B operations free each month', ops: 'Class A 4.50 USD and Class B 0.36 USD per million', notes: 'Egress to the internet is free. S3-compatible.', source: 'https://developers.cloudflare.com/r2/pricing/' }),
  Object.freeze({ id: 'backblaze_b2', name: 'Backblaze B2', storagePerGbMonth: 0.00695, egressPerGb: 0.01, included: 'egress free up to 3x the average stored data; free to Cloudflare and other partners', ops: '-', notes: '6.95 USD per TB-month pay as you go. S3-compatible.', source: 'https://www.backblaze.com/cloud-storage/pricing' }),
  Object.freeze({ id: 'supabase_pro', name: 'Supabase Pro (Storage)', storagePerGbMonth: 0.0213, egressPerGb: 0.09, included: '100 GB storage and 250 GB uncached egress in the 25 USD plan; cached egress 0.03 USD per GB beyond 250 GB', ops: '-', notes: 'Already PG1\'s vault. Uploads up to 500 GB per file on Pro.', source: 'https://supabase.com/docs/guides/storage/pricing' }),
  Object.freeze({ id: 'wasabi', name: 'Wasabi Hot Cloud Storage', storagePerGbMonth: 0.00799, egressPerGb: 0, included: 'no egress or API fees within the fair-use policy', ops: '-', notes: '7.99 USD per TB-month; 1 TB monthly minimum and 90-day minimum storage duration.', source: 'https://wasabi.com/pricing' }),
  Object.freeze({ id: 'aws_s3', name: 'Amazon S3 Standard (us-east-1)', storagePerGbMonth: 0.023, egressPerGb: 0.09, included: 'first 100 GB a month of egress free across AWS', ops: '-', notes: 'Storage and egress rates from AWS pages found by search; confirm on the S3 pricing page.', source: 'https://aws.amazon.com/s3/pricing/' })
]);

// Monthly USD for storing `gb` and serving `egressGb`, ignoring operations
// and plan fees.
export function storageMonthlyUsd(option, { gb, egressGb }) {
  let egress = egressGb * option.egressPerGb;
  if (option.id === 'backblaze_b2') egress = Math.max(0, egressGb - 3 * gb) * option.egressPerGb;
  if (option.id === 'supabase_pro') egress = Math.max(0, egressGb - 250) * option.egressPerGb;
  if (option.id === 'aws_s3') egress = Math.max(0, egressGb - 100) * option.egressPerGb;
  let stored = gb * option.storagePerGbMonth;
  if (option.id === 'supabase_pro') stored = Math.max(0, gb - 100) * option.storagePerGbMonth;
  if (option.id === 'wasabi') stored = Math.max(gb, 1000) * option.storagePerGbMonth;
  if (option.id === 'cloudflare_r2') stored = Math.max(0, gb - 10) * option.storagePerGbMonth;
  return round2(stored + egress);
}
