// PG1 Sound DAW export (/music export <id>), run by the render worker on
// GitHub Actions (scripts/music-render.mjs, .github/workflows/music-render.yml):
//
//   1. the master, converted to a 44.1 kHz 16-bit stereo WAV (ffmpeg)
//   2. Demucs (htdemucs, CPU) splits it into drums, bass, vocals and other
//      WAV stems; basic-pitch writes a MIDI file per melodic stem (bass,
//      vocals, other; no vocals MIDI for an instrumental); BPM and key are
//      detected from the master (scripts/music_stems.py)
//   3. everything is zipped as <title>_stems.zip with a README (BPM, key,
//      provider, licence note) and saved to the media library
//
// The README names the engine and its terms because the zip is the
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
    `${title} — stems export`,
    '='.repeat(Math.min(60, String(title).length + 16)),
    '',
    `Track id:   ${trackId}`,
    `Exported:   ${createdAt.toISOString()}`,
    `Length:     ${durationS ? `${Math.round(Number(durationS) * 10) / 10} s` : 'unknown'}`,
    `BPM:        ${fmtBpm(bpm)} (detected${requestedBpm ? `; asked for ${requestedBpm}` : ''})`,
    `Key:        ${key || 'not detected'} (detected${requestedKey ? `; asked for ${requestedKey}` : ''})`,
    `Vocals:     ${instrumental ? 'none (instrumental)' : 'yes'}`,
    '',
    'Made with',
    `  Provider: ${provider || 'unknown'}`,
    `  Model:    ${model || 'unknown'}`,
    `  Licence:  ${licenceNote || 'see the provider terms'}`,
    '',
    'Copyright',
    '  This is original, AI-generated music. No exclusive copyright is claimed',
    '  or granted by PG1; use of the audio is governed by the licence note',
    '  above and the provider terms it names.',
    '',
    'Files',
    ...files.map((f) => `  ${f}`),
    '',
    'Notes',
    '  - Stems: Demucs htdemucs (drums, bass, vocals, other), 44.1 kHz WAV.',
    '    They sum back to the master; small separation artefacts are normal.',
    '  - MIDI: basic-pitch transcription of each melodic stem. Expect to',
    '    quantise and clean up note lengths in your DAW.',
    '  - BPM and key are estimates from the master audio.',
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

// ffmpeg: any master to a 44.1 kHz 16-bit stereo WAV.
export async function toWav(input, out, { run = runCommand } = {}) {
  await run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-i', input, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', out]);
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

// The whole export for one track. Resolves to { path, name, bytes, bpm,
// key, files }. `store` is lib/music/store.mjs; `run` the command runner.
export async function runExport({ track, store, workdir, run = runCommand, now = new Date() }) {
  if (!track.master_path) throw Object.assign(new Error('the track has no master yet'), { code: 'no_master' });
  const slug = fileSlug(track.title);
  const ext = String(track.master_path).split('.').pop().toLowerCase();
  const src = path.join(workdir, `master-src.${ext}`);
  await writeFile(src, await store.download(track.master_path));
  const masterWav = path.join(workdir, `${slug}_master.wav`);
  await toWav(src, masterWav, { run });
  const options = track.options && typeof track.options === 'object' ? track.options : {};
  const manifest = await separate(masterWav, path.join(workdir, 'stems'), { instrumental: !!options.instrumental, run });

  const folder = `${slug}_stems`;
  const entries = [{ name: `${folder}/${slug}_master.wav`, data: await readFile(masterWav) }];
  for (const s of STEMS) entries.push({ name: `${folder}/stems/${slug}_${s}.wav`, data: await readFile(manifest.stems[s]) });
  for (const s of MIDI_STEMS) {
    const f = manifest.midi && manifest.midi[s];
    if (typeof f === 'string') entries.push({ name: `${folder}/midi/${slug}_${s}.mid`, data: await readFile(f) });
  }
  const bpm = Number.isFinite(Number(manifest.bpm)) && Number(manifest.bpm) > 0 ? Math.round(Number(manifest.bpm) * 100) / 100 : null;
  const key = typeof manifest.key === 'string' && manifest.key ? manifest.key.slice(0, 24) : null;
  const files = entries.map((e) => e.name.slice(folder.length + 1));
  const readme = exportReadme({
    title: track.title || 'Untitled track', trackId: track.id, bpm, key, requestedBpm: options.bpm || null, requestedKey: options.key || null,
    provider: track.provider, model: track.model, licenceNote: track.licence_note, durationS: track.duration_s, instrumental: !!options.instrumental,
    files: ['README.txt', ...files], createdAt: now
  });
  entries.unshift({ name: `${folder}/README.txt`, data: readme });
  const bytes = buildZip(entries, { now });
  const name = `${slug}_stems.zip`;
  const stored = await store.upload(musicPath(track.id, 'export', `v${track.version || 1}-${name}`), bytes, 'application/zip');
  return { path: stored, name, bytes, bpm, key, files: ['README.txt', ...files] };
}
