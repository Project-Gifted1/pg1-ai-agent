const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");

const VOICE_OPTIONS = {
  christopher: "en-US-ChristopherNeural",
  steffan: "en-US-SteffanNeural",
  ryan: "en-GB-RyanNeural",
  aria: "en-US-AriaNeural",
  eric: "en-US-EricNeural",
  guy: "en-US-GuyNeural"
};

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  let text = "PG1 Sovereign Intelligence Online.";
  let selectedVoice = VOICE_OPTIONS.christopher;

  if (req.method === "POST") {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
    text = body?.text || text;
    if (body?.voice) {
       selectedVoice = VOICE_OPTIONS[body.voice.toLowerCase()] || body.voice;
    }
  } else if (req.method === "GET") {
    text = req.query?.text || text;
    if (req.query?.voice) {
       selectedVoice = VOICE_OPTIONS[req.query.voice.toLowerCase()] || req.query.voice;
    }
  }

  try {
    const cleanText = text.replace(/[*#`_~]/g, "").trim() || "No input detected.";
    const tts = new MsEdgeTTS();
    
    await tts.setMetadata(selectedVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

    const readable = tts.toStream(cleanText);
    const chunks = [];

    readable.on("data", (chunk) => chunks.push(chunk));
    readable.on("end", () => {
      const audioBuffer = Buffer.concat(chunks);
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "no-cache");
      return res.status(200).send(audioBuffer);
    });
    
    readable.on("error", (err) => {
      console.error("Stream error:", err);
      if (!res.headersSent) res.status(500).json({ error: "Stream failed" });
    });

  } catch (err) {
    console.error("TTS Error:", err);
    return res.status(500).json({ error: err.message });
  }
};
