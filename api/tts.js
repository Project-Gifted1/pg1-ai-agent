export const config = {
  runtime: 'edge',
  maxDuration: 60
};

function sendJSON(status, data) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return sendJSON(200, {});
  if (req.method !== 'POST') return sendJSON(405, { error: 'Method Not Allowed' });

  // DIAGNOSTIC (issue #53 — voice latency): additive stage timing for this Edge
  // TTS route. Emits one [PG1-TIMING] log line and returns the same data as
  // `timings` on the JSON response. No behavior change.
  const t0 = Date.now();
  const stages = [];
  const record = (stage, startedAt, meta) => {
    stages.push({ stage, atMs: startedAt - t0, durMs: Date.now() - startedAt, meta: meta || null });
  };
  const flush = () => {
    const snap = { route: 'api/tts.js(edge)', totalMs: Date.now() - t0, stages };
    try { console.log('[PG1-TIMING] ' + JSON.stringify(snap)); } catch (e) {}
    return snap;
  };

  try {
    const bodyText = await req.text();
    const body = JSON.parse(bodyText);
    const { text, voiceId } = body;

    if (!text) return sendJSON(400, { error: 'No text provided' });

    const cartesiaKey = (process.env.CARTESIA_API_KEY || '').replace(/\s+/g, '');
    const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\s+/g, '');
    const supabaseKey = (process.env.SUPABASEAPI_KEY || '').replace(/\s+/g, '');
    
    if (!cartesiaKey) return sendJSON(500, { error: 'Missing TTS API Key' });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const ttsStart = Date.now();
    const ttsRes = await fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: { 
        'Cartesia-Version': '2024-06-10', 
        'X-API-Key': cartesiaKey, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({
        model_id: process.env.CARTESIA_MODEL_ID || 'sonic-3.6',
        transcript: text.replace(/[*_#`[\]()]/g, '').substring(0, 3000).trim(),
        voice: { mode: 'id', id: voiceId || 'a0e99841-438c-4a64-b679-ae501e7d6091' },
        output_format: { container: 'mp3', sample_rate: 44100 }
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    record('tts_cartesia', ttsStart, { status: ttsRes.status, transcriptChars: text.length });

    if (!ttsRes.ok) return sendJSON(502, { error: `Cartesia API Error: ${ttsRes.status}`, timings: flush() });

    const downloadStart = Date.now();
    const arrayBuffer = await ttsRes.arrayBuffer();
    record('tts_body_download', downloadStart, { audioBytes: arrayBuffer.byteLength });

    if (supabaseUrl && supabaseKey) {
      const fileName = `tts_${Date.now()}.mp3`;
      const uploadStart = Date.now();
      const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/pg1-vault/${fileName}`, {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'audio/mp3'
        },
        body: arrayBuffer
      });
      record('tts_supabase_upload', uploadStart, { status: uploadRes.status, ok: uploadRes.ok });

      if (uploadRes.ok) {
        return sendJSON(200, {
          success: true,
          audioUrl: `${supabaseUrl}/storage/v1/object/public/pg1-vault/${fileName}`,
          timings: flush()
        });
      }
    }

    const encodeStart = Date.now();
    const audioBase64 = arrayBufferToBase64(arrayBuffer);
    record('tts_base64_encode', encodeStart, { audioBytes: arrayBuffer.byteLength });

    return sendJSON(200, {
      success: true,
      audioBase64: audioBase64,
      audioMimeType: 'audio/mp3',
      timings: flush()
    });

  } catch (err) {
    return sendJSON(500, { error: err.message, timings: flush() });
  }
}
