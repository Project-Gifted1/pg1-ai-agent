import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  let text = "PG1 Sovereign Intelligence Online.";
  let voice = "en-US-GuyNeural";

  if (req.method === "POST") {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
    text = body?.text || text;
    voice = body?.voice || voice;
  } else if (req.method === "GET") {
    text = req.query?.text || text;
    voice = req.query?.voice || voice;
  }

  try {
    const cleanText = text.replace(/[*#`_~]/g, "").trim();
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

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
