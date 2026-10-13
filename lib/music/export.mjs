// PG1 Sound DAW export (/music export <id>), run by the render worker on
// GitHub Actions (scripts/music-render.mjs, .github/workflows/music-render.yml):
//
//   1. the master, converted to a 44.1 kHz 16-bit stereo WAV for the
//      separation (ffmpeg)
//   2. Demucs (htdemucs, CPU) splits it into drums, bass, vocals and other;
//      basic-pitch writes a MIDI file per melodic stem (bass, vocals, other;
//      no vocals MIDI for an instrumental); BPM and key are detected from
//      the master (scripts/music_stems.py)
//   3. the master and the four stems are encoded as FLAC (lossless, about
//      half the size of WAV) and every file is uploaded on its own:
//      master.flac, drums.flac, bass.flac, vocals.flac, other.flac, the MIDI
//      files and README.md
//   4. then <title>_stems.zip of all of them, uploaded only when it fits
//      under the storage limit; otherwise the separate files are the export
//
// Storage limit. Every upload is checked against PG1_STORAGE_MAX_MB
// (default 48, under the Supabase Free plan's 50 MB per file) before it is
// sent (guardedUpload). A file over it stops the stage with "file too
// large for storage limit" (StorageLimitError); only the optional zip is
// skipped instead.
//
// The README names the engine and its terms because the export is the
// operator's own download; it never claims exclusive copyright.

import path from 'node:path';
import zlib from 'node:zlib';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileSlug } from './text.mjs';
import { musicPath } from './store.mjs';

export const STEMS = Object.freeze(['drums', 'bass', 'vocals', 'other']);
export const MIDI_STEMS = Object.freeze(['bass', 'vocals', 'other']);
export const STEMS_SCRIPT = 'scripts/music_stems.py';

// --- the storage limit -------------------------------------------------------------

export const DEFAULT_STORAGE_MAX_MB = 48;
export const MB = 1024 * 1024;
export const FILE_TOO_LARGE = 'file too large for storage limit';

export function storageMaxMb(env = {}) {
  const raw = String(env.PG1_STORAGE_MAX_MB == null ? '' : env.PG1_STORAGE_MAX_MB).trim();
  const n = Number(raw);
  return raw && /^\d+(?:\.\d+)?$/.test(raw) && n > 0 ? n : DEFAULT_STORAGE_MAX_MB;
}

export function storageMaxBytes(env = {}) {
  return Math.floor(storageMaxMb(env) * MB);
}

export class StorageLimitError extends Error {
  constructor(name, bytes, maxBytes) {
    super(`${FILE_TOO_LARGE}: ${name} is ${(bytes / MB).toFixed(1)} MB, the limit is ${(maxBytes / MB).toFixed(1)} MB`);
    this.code = 'file_too_large';
    this.name = 'StorageLimitError';
    this.file = name;
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

// Every upload of a music file goes through here: checked first, never sent
// when it is over the limit.
export async function guardedUpload(store, storagePath, bytes, mime, maxBytes) {
  const size = Buffer.byteLength(bytes);
  if (size > maxBytes) throw new StorageLimitError(path.basename(storagePath), size, maxBytes);
  return store.upload(storagePath, bytes, mime);
}

// --- zip (store or deflate, no dependencies) --------------------------------------

function dosTime(d) {
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
  const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

// entries: [{ name, data (Buffer|string) }]. Audio is stored (it does not
// compress); text and MIDI are deflated.
export function buildZip(entries, { now = new Date() } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const { time, date } = dosTime(now);
  for (const e of entries) {
    const name = Buffer.from(String(e.name).replace(/\\/g, '/'), 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const crc = zlib.crc32(data) >>> 0;
    const deflate = !/\.(?:wav|mp3|flac|ogg|m4a|zip)$/i.test(e.name);
    const body = deflate ? zlib.deflateRawSync(data, { level: 9 }) : data;
    const method = deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// The entries of a zip buildZip made (and any plain zip without data
// descriptors): [{ name, data }], each checked against its CRC.
export function readZip(buf) {
  const endAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(endAt + 10);
  let p = buf.readUInt32LE(endAt + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const lstart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(lstart, lstart + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    if ((zlib.crc32(data) >>> 0) !== crc) throw new Error(`crc mismatch in ${name}`);
    out.push({ name, data });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

// --- the README ------------------------------------------------------------------------

const fmtBpm = (b) => (b == null || !Number.isFinite(Number(b)) ? 'not detected' : `${Math.round(Number(b) * 100) / 100}`);

export function exportReadme({ title, trackId, bpm, key, requestedBpm = null, requestedKey = null, provider, model, licenceNote, durationS = null, instrumental = false, files = [], createdAt = new Date() }) {
  return [
    `# ${title} — stems export`,
    '',
    `- Track id: ${trackId}`,
    `- Exported: ${createdAt.toISOString()}`,
    `- Length: ${durationS ? `${Math.round(Number(durationS) * 10) / 10} s` : 'unknown'}`,
    `- BPM: ${fmtBpm(bpm)} (detected${requestedBpm ? `; asked for ${requestedBpm}` : ''})`,
    `- Key: ${key || 'not detected'} (detected${requestedKey ? `; asked for ${requestedKey}` : ''})`,
    `- Vocals: ${instrumental ? 'none (instrumental)' : 'yes'}`,
    '',
    '## Made with',
    '',
    `- Provider: ${provider || 'unknown'}`,
    `- Model: ${model || 'unknown'}`,
    `- Licence: ${licenceNote || 'see the provider terms'}`,
    '',
    '## Copyright',
    '',
    'This is original, AI-generated music. No exclusive copyright is claimed',
    'or granted by PG1; use of the audio is governed by the licence note',
    'above and the provider terms it names.',
    '',
    '## Files',
    '',
    ...files.map((f) => `- ${f}`),
    '',
    '## Notes',
    '',
    '- The master and the stems are FLAC: lossless, 44.1 kHz, 16-bit stereo,',
    '  about half the size of WAV. Any DAW can import them as they are, or',
    '  convert them to WAV (for example: ffmpeg -i drums.flac drums.wav).',
    '- Stems: Demucs htdemucs (drums, bass, vocals, other). They sum back to',
    '  the master; small separation artefacts are normal.',
    '- MIDI: basic-pitch transcription of each melodic stem. Expect to',
    '  quantise and clean up note lengths in your DAW.',
    '- BPM and key are estimates from the master audio.',
    ''
  ].join('\n');
}

// --- the export run ----------------------------------------------------------------------

// Runs a command. Resolves to { stdout, stderr }; rejects with the tail of
// stderr.
export function runCommand(bin, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; if (stdout.length > 1e6) stdout = stdout.slice(-1e6); });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 1e6) stderr = stderr.slice(-1e6); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${bin} exited ${code}: ${stderr.slice(-800)}`))));
  });
}

const ffmpegArgs = (input, codec, out) => ['-hide_banner', '-nostdin', '-y', '-i', input, '-vn', '-ac', '2', '-ar', '44100', ...codec, out];

// ffmpeg: any audio to a 44.1 kHz 16-bit stereo WAV (for the separation).
export async function toWav(input, out, { run = runCommand } = {}) {
  await run('ffmpeg', ffmpegArgs(input, ['-c:a', 'pcm_s16le'], out));
  return out;
}

// ffmpeg: the first `seconds` of a track, with a short fade out, in the
// same format (by the output's extension).
const TRIM_CODECS = { mp3: ['-c:a', 'libmp3lame', '-q:a', '2'], wav: ['-c:a', 'pcm_s16le'], flac: ['-c:a', 'flac'], ogg: ['-c:a', 'libvorbis', '-q:a', '6'], m4a: ['-c:a', 'aac', '-b:a', '256k'] };
export async function trimAudio(input, out, seconds, { run = runCommand } = {}) {
  const ext = String(out).split('.').pop().toLowerCase();
  const fade = Math.min(1.5, seconds / 10);
  await run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-i', input, '-vn', '-t', String(seconds), '-af', `afade=t=out:st=${seconds - fade}:d=${fade}`, ...(TRIM_CODECS[ext] || TRIM_CODECS.wav), out]);
  return out;
}

// ffmpeg: any audio to a 44.1 kHz 16-bit stereo FLAC (lossless).
export async function toFlac(input, out, { run = runCommand } = {}) {
  await run('ffmpeg', ffmpegArgs(input, ['-c:a', 'flac', '-sample_fmt', 's16', '-compression_level', '8'], out));
  return out;
}

// The stems script's manifest: { stems: { drums: file, ... }, midi: {
// bass: file, ... }, bpm, key }. `run` is the command runner (a stand-in in
// the tests).
export async function separate(wav, outDir, { instrumental = false, run = runCommand, python = process.env.PG1_MUSIC_PYTHON || 'python3' } = {}) {
  const args = [STEMS_SCRIPT, wav, outDir, ...(instrumental ? ['--no-vocals-midi'] : [])];
  const { stdout } = await run(python, args);
  const line = String(stdout).trim().split('\n').filter(Boolean).pop() || '';
  let manifest;
  try { manifest = JSON.parse(line); } catch (e) { throw new Error(`the stems script printed no manifest: ${line.slice(0, 200)}`); }
  for (const s of STEMS) if (!manifest.stems || typeof manifest.stems[s] !== 'string') throw new Error(`the stems script made no ${s} stem`);
  return manifest;
}

// The whole export for one track. Every file is uploaded on its own first
// (each checked against `maxBytes`: one over it throws StorageLimitError and
// stops the export), then the zip of them all, only when it fits.
// Resolves to { parts: [{ part, stem?, name, path, mime, size }], zip: {
// name, path, size } | null, zipSkipped: { size } | null, bpm, key }.
export async function runExport({ track, store, workdir, maxBytes = storageMaxBytes(), run = runCommand, now = new Date() }) {
  if (!track.master_path) throw Object.assign(new Error('the track has no master yet'), { code: 'no_master' });
  const slug = fileSlug(track.title);
  const version = track.version || 1;
  const ext = String(track.master_path).split('.').pop().toLowerCase();
  const src = path.join(workdir, `master-src.${ext}`);
  await writeFile(src, await store.download(track.master_path));
  const masterWav = path.join(workdir, 'master.wav');
  await toWav(src, masterWav, { run });
  const options = track.options && typeof track.options === 'object' ? track.options : {};
  const manifest = await separate(masterWav, path.join(workdir, 'stems'), { instrumental: !!options.instrumental, run });

  // Encode the master and the stems as FLAC.
  const files = [{ part: 'master', name: 'master.flac', file: await toFlac(masterWav, path.join(workdir, 'master.flac'), { run }), mime: 'audio/flac' }];
  for (const s of STEMS) files.push({ part: s, name: `${s}.flac`, file: await toFlac(manifest.stems[s], path.join(workdir, `${s}.flac`), { run }), mime: 'audio/flac' });
  for (const s of MIDI_STEMS) {
    const f = manifest.midi && manifest.midi[s];
    if (typeof f === 'string') files.push({ part: 'midi', stem: s, name: `${s}.mid`, file: f, mime: 'audio/midi' });
  }
  const bpm = Number.isFinite(Number(manifest.bpm)) && Number(manifest.bpm) > 0 ? Math.round(Number(manifest.bpm) * 100) / 100 : null;
  const key = typeof manifest.key === 'string' && manifest.key ? manifest.key.slice(0, 24) : null;
  const readmeText = exportReadme({
    title: track.title || 'Untitled track', trackId: track.id, bpm, key, requestedBpm: options.bpm || null, requestedKey: options.key || null,
    provider: track.provider, model: track.model, licenceNote: track.licence_note, durationS: track.duration_s, instrumental: !!options.instrumental,
    files: [...files.map((f) => (f.part === 'midi' ? `midi/${f.name}` : f.part === 'master' ? f.name : `stems/${f.name}`)), 'README.md'], createdAt: now
  });

  // Read and check every file before any upload, so an export that cannot
  // fit leaves nothing half-stored.
  const datas = [];
  for (const f of files) datas.push({ ...f, data: await readFile(f.file) });
  datas.push({ part: 'readme', name: 'README.md', data: Buffer.from(readmeText, 'utf8'), mime: 'text/markdown' });
  for (const f of datas) if (f.data.length > maxBytes) throw new StorageLimitError(f.name, f.data.length, maxBytes);

  const parts = [];
  for (const f of datas) {
    const storagePath = musicPath(track.id, 'export', `v${version}-${f.part === 'midi' ? `midi-${f.name}` : f.name}`);
    await guardedUpload(store, storagePath, f.data, f.mime, maxBytes);
    parts.push({ part: f.part, ...(f.stem ? { stem: f.stem } : {}), name: f.name, download: `${slug}_${f.part === 'midi' ? `${f.stem}.mid` : f.name}`, path: storagePath, mime: f.mime, size: f.data.length });
  }

  // The bundle: only when it fits; otherwise the separate files are the export.
  const folder = `${slug}_stems`;
  const where = (f) => (f.part === 'midi' ? 'midi/' : f.part === 'master' || f.part === 'readme' ? '' : 'stems/');
  const zip = buildZip(datas.map((f) => ({ name: `${folder}/${where(f)}${f.part === 'readme' ? 'README.md' : `${slug}_${f.part === 'midi' ? f.stem : f.part}.${f.name.split('.').pop()}`}`, data: f.data })), { now });
  const zipName = `${slug}_stems.zip`;
  let zipOut = null;
  let zipSkipped = null;
  if (zip.length <= maxBytes) {
    const zipPath = musicPath(track.id, 'export', `v${version}-${zipName}`);
    await guardedUpload(store, zipPath, zip, 'application/zip', maxBytes);
    zipOut = { name: zipName, path: zipPath, size: zip.length };
  } else {
    zipSkipped = { name: zipName, size: zip.length };
  }
  return { parts, zip: zipOut, zipSkipped, bpm, key };
}
