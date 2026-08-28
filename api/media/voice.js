const { PG1VoiceRouter } = require('../../lib/voiceRouter');
const { PG1CostTracker } = require('../../lib/costTracker');

const DEFAULT_ALLOWED_ORIGINS = [
  'https://pg1-ai-agent.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173'
];

function getAllowedOrigins() {
  const configuredOrigins = process.env.PG1_ALLOWED_ORIGINS
    ? process.env.PG1_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
    : [];
  return configuredOrigins.length ? configuredOrigins : DEFAULT_ALLOWED_ORIGINS;
}

function applyCors(req, res) {
  const allowedOrigins = getAllowedOrigins();
  const requestOrigin = req.headers.origin;
  const matchedOrigin = allowedOrigins.includes(requestOrigin) ? requestOrigin : allowedOrigins[0];

  if (matchedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', matchedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST,GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const voiceRouter = new PG1VoiceRouter();

    if (req.method === 'GET') {
      if (req.query && req.query.action === 'list') {
        const voices = await voiceRouter.getAllVoices();
        const neuralVoices = voices.filter((voice) => Array.isArray(voice.SupportedEngines) && voice.SupportedEngines.includes('neural'));
        return res.status(200).json({
          voices: neuralVoices.map((voice) => ({
            id: voice.Id,
            name: voice.Name,
            language: voice.LanguageName,
            engine: 'neural'
          })),
          total: neuralVoices.length,
          freeLimit: '5M characters/month'
        });
      }
      return res.status(400).json({ error: 'Unsupported action' });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const body = req.body || {};
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const context = typeof body.context === 'string' && body.context ? body.context : 'neutral';

    if (!text) return res.status(400).json({ error: 'Missing text parameter' });
    if (text.length > 3000) {
      return res.status(413).json({
        error: 'Text too long (max 3000 characters)',
        length: text.length
      });
    }

    const result = await voiceRouter.generateVoice(text, context);
    const costTracker = new PG1CostTracker();
    const cost = 0;
    await costTracker.trackVoiceGeneration('amazon-polly', text.length, cost);

    return res.status(200).json({
      success: true,
      voice: result.voice,
      context,
      cost,
      costLabel: 'FREE - Amazon Polly Free Tier',
      charactersUsed: text.length,
      freeLimit: '5M/month',
      fromCache: result.fromCache,
      quality: '⭐⭐⭐⭐',
      provider: 'amazon-polly',
      timestamp: new Date().toISOString(),
      audioBase64: Buffer.from(result.audio).toString('base64')
    });
  } catch (error) {
    console.error('Voice generation failed:', error);
    return res.status(500).json({
      error: error.message || 'Voice generation failed',
      provider: 'amazon-polly',
      recommendation: 'Check AWS credentials and free tier limits'
    });
  }
};
