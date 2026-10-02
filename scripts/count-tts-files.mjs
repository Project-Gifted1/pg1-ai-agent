#!/usr/bin/env node
// Read-only: counts the tts_*.mp3 files the one-shot SPEAK action has saved
// to the pg1-vault bucket, and their total size. Deletes nothing.
//
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/count-tts-files.mjs
//
// (SUPABASEAPI_KEY is accepted too, same as api/chat.mjs.)

const url = (process.env.SUPABASE_URL || '').replace(/\s+/g, '').replace(/\/+$/, '');
const key = (process.env.SUPABASEAPI_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLEKEY || '').replace(/\s+/g, '');
const BUCKET = 'pg1-vault';
const PAGE = 1000;

export async function countTtsFiles({ supabaseUrl, supabaseKey, fetchImpl = globalThis.fetch }) {
  let offset = 0;
  let count = 0;
  let bytes = 0;
  let oldest = null;
  let newest = null;
  for (;;) {
    const res = await fetchImpl(`${supabaseUrl}/storage/v1/object/list/${BUCKET}`, {
      method: 'POST',
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: '', search: 'tts_', limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } })
    });
    if (!res.ok) throw new Error(`Storage list failed (${res.status})`);
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;
    for (const f of page) {
      const name = String((f && f.name) || '');
      if (!/^tts_.*\.mp3$/.test(name)) continue;
      count++;
      bytes += Number((f.metadata && f.metadata.size) || 0);
      const at = f.created_at || null;
      if (at && (!oldest || at < oldest)) oldest = at;
      if (at && (!newest || at > newest)) newest = at;
    }
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return { count, bytes, oldest, newest };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  if (!url || !key) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASEAPI_KEY).');
    process.exit(1);
  }
  countTtsFiles({ supabaseUrl: url, supabaseKey: key }).then(({ count, bytes, oldest, newest }) => {
    console.log(`${BUCKET}: ${count} tts_*.mp3 file${count === 1 ? '' : 's'}, ${(bytes / 1024 / 1024).toFixed(2)} MB (${bytes} bytes)`);
    if (count) console.log(`oldest ${oldest || 'unknown'}, newest ${newest || 'unknown'}`);
  }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
