#!/usr/bin/env node

const { PG1VoiceRouter } = require('../lib/voiceRouter');

async function testVoice() {
  console.log('🎙️ Testing Amazon Polly Voice Generation');
  const voiceRouter = new PG1VoiceRouter();
  const testPhrase = 'PG1 Sovereign Agent is online and ready to assist you.';

  try {
    console.log(`📝 Test phrase: "${testPhrase}"`);
    const result = await voiceRouter.generateVoice(testPhrase, 'professional-female');

    console.log('✅ Voice generated successfully!');
    console.log(`   Voice: ${result.voice}`);
    console.log(`   Cost: $${result.cost} (FREE!)`);
    console.log(`   Quality: ${result.quality}`);
    console.log(`   Characters: ${result.charactersUsed}`);
    console.log(`   Cache: ${result.fromCache ? 'HIT' : 'MISS'}`);
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

testVoice();
