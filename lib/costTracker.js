const fs = require('fs');
const path = require('path');

class PG1CostTracker {
  constructor() {
    this.logFile = path.resolve('./cache/voice-generation-logs.jsonl');
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
  }

  async trackVoiceGeneration(provider, charactersGenerated, cost) {
    const today = new Date().toISOString().split('T')[0];
    const voiceCosts = {
      today,
      provider,
      characters: Number(charactersGenerated) || 0,
      cost: Number(cost) || 0,
      freeLimit: '5M characters/month',
      status: 'FREE_TIER',
      timestamp: new Date().toISOString()
    };

    fs.appendFileSync(this.logFile, `${JSON.stringify(voiceCosts)}\n`);
    return voiceCosts;
  }
}

module.exports = { PG1CostTracker };
