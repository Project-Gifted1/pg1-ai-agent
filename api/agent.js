const { PG1VoiceRouter } = require('../lib/voiceRouter');

async function generateAgentVoiceResponse(agentResponse, priority = 'neutral') {
  const voiceRouter = new PG1VoiceRouter();
  const contextMap = {
    status: 'professional-female',
    error: 'authoritative',
    success: 'warm',
    thinking: 'neutral',
    planning: 'professional-male',
    executing: 'technical-male',
    complete: 'friendly-female'
  };

  const context = contextMap[priority] || 'neutral';
  const voiceResult = await voiceRouter.generateVoice(agentResponse, context);

  return {
    text: agentResponse,
    voice: voiceResult.voice,
    audio: voiceResult.audio,
    cost: 0,
    freetier: true
  };
}

module.exports = { generateAgentVoiceResponse };
