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

    if (!ttsRes.ok) return sendJSON(502, { error: `Cartesia API Error: ${ttsRes.status}` });

    const arrayBuffer = await ttsRes.arrayBuffer();
    
    if (supabaseUrl && supabaseKey) {
      const fileName = `tts_${Date.now()}.mp3`;
      const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/pg1-vault/${fileName}`, {
        method: 'POST',
        headers: { 
          'apikey': supabaseKey, 
          'Authorization': `Bearer ${supabaseKey}`, 
          'Content-Type': 'audio/mp3' 
        },
        body: arrayBuffer
      });
      
      if (uploadRes.ok) {
        return sendJSON(200, { 
          success: true, 
          audioUrl: `${supabaseUrl}/storage/v1/object/public/pg1-vault/${fileName}` 
        });
      }
    }

    return sendJSON(200, { 
      success: true, 
      audioBase64: arrayBufferToBase64(arrayBuffer),
      audioMimeType: 'audio/mp3'
    });

  } catch (err) {
    return sendJSON(500, { error: err.message });
  }
}
