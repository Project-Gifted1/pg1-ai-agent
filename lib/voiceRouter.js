const {
  PollyClient,
  SynthesizeSpeechCommand,
  DescribeVoicesCommand
} = require('@aws-sdk/client-polly');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class PG1VoiceRouter {
  constructor() {
    this.region = this.validateRegion(process.env.AWS_REGION || 'us-east-1');
    this.cacheEnabled = process.env.PG1_VOICE_CACHE_ENABLED === 'true';
    this.cacheDir = process.env.PG1_VOICE_CACHE_DIR || './cache/voices';
    this.defaultVoice = process.env.PG1_DEFAULT_VOICE || 'Joanna';

    this.voiceMap = {
      'professional-male': process.env.PG1_VOICE_PROFESSIONAL_MALE || 'Matthew',
      'professional-female': process.env.PG1_VOICE_PROFESSIONAL_FEMALE || 'Joanna',
      'friendly-male': process.env.PG1_VOICE_FRIENDLY_MALE || 'Joey',
      'friendly-female': process.env.PG1_VOICE_FRIENDLY_FEMALE || 'Amy',
      'technical-male': process.env.PG1_VOICE_TECHNICAL_MALE || 'Brian',
      'technical-female': process.env.PG1_VOICE_TECHNICAL_FEMALE || 'Ivy',
      'luxury-male': process.env.PG1_VOICE_LUXURY_MALE || 'Geraint',
      'luxury-female': process.env.PG1_VOICE_LUXURY_FEMALE || 'Aditi',
      neutral: this.defaultVoice,
      authoritative: process.env.PG1_VOICE_PROFESSIONAL_MALE || 'Matthew',
      warm: process.env.PG1_VOICE_PROFESSIONAL_FEMALE || 'Joanna',
      clear: process.env.PG1_VOICE_FRIENDLY_MALE || 'Joey'
    };

    if (this.cacheEnabled) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }

    this.polly = null;
    this._hasCredentials = Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
    if (this._hasCredentials) {
      this.polly = new PollyClient({
        region: this.region,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        }
      });
    }
  }

  ensurePolly() {
    if (!this.polly) {
      throw new Error('AWS Polly credentials are missing. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.');
    }
    return this.polly;
  }

  selectVoiceForContext(context = 'neutral') {
    return this.voiceMap[context] || this.defaultVoice;
  }

  async generateVoice(text, context = 'neutral') {
    if (!text || typeof text !== 'string') {
      throw new Error('Text is required for voice generation.');
    }

    if (this.cacheEnabled) {
      const cached = this.getCachedVoice(text, context);
      if (cached) {
        return {
          audio: cached.audio,
          audioPath: cached.path,
          voice: this.selectVoiceForContext(context),
          fromCache: true,
          cost: 0,
          freetier: true,
          provider: 'amazon-polly',
          charactersUsed: text.length,
          quality: '⭐⭐⭐⭐'
        };
      }
    }

    const voice = this.selectVoiceForContext(context);
    const polly = this.ensurePolly();
    const result = await polly.send(new SynthesizeSpeechCommand({
      Text: text,
      OutputFormat: process.env.PG1_VOICE_FORMAT || 'mp3',
      VoiceId: voice,
      Engine: 'neural'
    }));

    const audioBuffer = await this.audioStreamToBuffer(result.AudioStream);

    const audioPath = this.cacheEnabled ? this.saveCachedVoice(text, context, audioBuffer) : null;
    return {
      audio: audioBuffer,
      audioPath,
      voice,
      cost: 0,
      freetier: true,
      provider: 'amazon-polly',
      charactersUsed: text.length,
      fromCache: false,
      quality: '⭐⭐⭐⭐'
    };
  }

  getCachedVoice(text, context) {
    if (!this.cacheEnabled) return null;
    const hash = this.hashText(text, context);
    const filePath = path.join(this.cacheDir, `${hash}.mp3`);
    if (!fs.existsSync(filePath)) return null;
    return { path: filePath, audio: fs.readFileSync(filePath) };
  }

  saveCachedVoice(text, context, audioStream) {
    if (!this.cacheEnabled) return null;
    const hash = this.hashText(text, context);
    const filePath = path.join(this.cacheDir, `${hash}.mp3`);
    fs.writeFileSync(filePath, audioStream);
    return filePath;
  }

  hashText(text, context) {
    return crypto.createHash('md5').update(`${text}:${context}`).digest('hex');
  }

  validateRegion(region) {
    const safeRegion = String(region || '').trim();
    const regionPattern = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
    if (!regionPattern.test(safeRegion)) {
      throw new Error('Invalid AWS region format.');
    }
    return safeRegion;
  }

  async audioStreamToBuffer(audioStream) {
    if (!audioStream) return Buffer.alloc(0);
    if (Buffer.isBuffer(audioStream)) return audioStream;
    if (audioStream instanceof Uint8Array) return Buffer.from(audioStream);
    if (typeof audioStream.transformToByteArray === 'function') {
      const bytes = await audioStream.transformToByteArray();
      return Buffer.from(bytes);
    }
    const chunks = [];
    for await (const chunk of audioStream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async getAllVoices() {
    const polly = this.ensurePolly();
    const result = await polly.send(new DescribeVoicesCommand({}));
    return result.Voices || [];
  }

  async getVoiceInfo(voiceId) {
    const voices = await this.getAllVoices();
    return voices.find((voice) => voice.Id === voiceId) || null;
  }
}

module.exports = { PG1VoiceRouter };
