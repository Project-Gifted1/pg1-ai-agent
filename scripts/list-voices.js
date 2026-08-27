#!/usr/bin/env node

const { PG1VoiceRouter } = require('../lib/voiceRouter');

async function listVoices() {
  const voiceRouter = new PG1VoiceRouter();
  const voices = await voiceRouter.getAllVoices();
  const neuralVoices = voices.filter((voice) => Array.isArray(voice.SupportedEngines) && voice.SupportedEngines.includes('neural'));

  console.log(`🎙️ Neural voices available: ${neuralVoices.length}`);
  neuralVoices.forEach((voice) => {
    console.log(`${voice.Id} - ${voice.Name} (${voice.LanguageName})`);
  });
}

listVoices().catch((error) => {
  console.error('❌ Failed to list voices:', error.message);
  process.exit(1);
});
