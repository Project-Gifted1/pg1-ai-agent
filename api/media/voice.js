import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

// Built-in dictionary of premium neural voices for easy switching
const VOICE_OPTIONS = {
  christopher: "en-US-ChristopherNeural", // Deep, calm, professional male
  steffan: "en-US-SteffanNeural",         // Crisp, authoritative male
  ryan: "en-GB-RyanNeural",               // Sharp, articulate British male
  aria: "en-US-AriaNeural",               // Natural, expressive female
  eric: "en-US-EricNeural",               // Conversational, relatable male
  guy: "en-US-GuyNeural"                  // Baseline standard male
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  let text = "PG1 Sovereign Intelligence Online.";
  let selectedVoice = VOICE_OPTIONS.christopher; // Default voice

  if (req.method === "POST") {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
    text = body?.text || text;
    
    // Allow switching by shortname (e.g., "steffan") or exact string
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
    // Strips markdown characters but preserves commas and periods for natural breathing pauses
    const cleanText = text.replace(/[*#`_~]/g, "").trim();
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
  } catch (err) {
    console.error("TTS Error:", err);
    return res.status(500).json({ error: err.message });
  }
}
