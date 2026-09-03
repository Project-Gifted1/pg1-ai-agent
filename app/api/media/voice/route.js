export const maxDuration = 30;

export default async function handler(req, res) {
  // CORS Headers for Vercel Serverless
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }

    const text = body?.text;
    const voice = body?.voice || 'alloy';

    if (!text) {
      return res.status(400).json({ error: 'Execution halted: Text payload missing.' });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'System Alert: OPENAI_API_KEY is missing from Vercel.' });
    }

    // Map your custom UI voices to OpenAI's native TTS-1 voices
    const voiceMap = {
      christopher: 'onyx',
      steffan: 'echo',
      ryan: 'fable',
      aria: 'nova'
    };

    const targetVoice = voiceMap[voice.toLowerCase()] || 'onyx';

    // Dispatch to OpenAI
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: text.substring(0, 4000), // Hard cap to protect API token limits
        voice: targetVoice
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: `OpenAI Gateway Error: ${errText}` });
    }

    // Convert the audio stream into a buffer and send it to the frontend player
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'no-cache');
    
    return res.status(200).send(buffer);
  } catch (err) {
    return res.status(500).json({ error: `Audio synthesis fatal error: ${err.message}` });
  }
}
