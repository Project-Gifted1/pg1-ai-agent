/**
 * Memory System Module
 * Persistent learning from execution patterns
 * Tracks success rates and optimizes future decisions
 */

const fs = require('fs');
const path = require('path');

class MemorySystem {
  constructor() {
    this.memoryFile = path.join('/tmp', '.pg1-memory.json');
    this.memory = this.load();
  }

  /**
   * Load memory from disk
   */
  load() {
    try {
      if (fs.existsSync(this.memoryFile)) {
        const data = fs.readFileSync(this.memoryFile, 'utf-8');
        return JSON.parse(data);
      }
    } catch (err) {
      console.warn('Could not load memory:', err.message);
    }
    return {
      executions: [],
      patterns: {},
      successCount: 0,
      failureCount: 0,
      timestamp: Date.now()
    };
  }

  /**
   * Save memory to disk
   */
  save() {
    try {
      fs.writeFileSync(this.memoryFile, JSON.stringify(this.memory, null, 2));
    } catch (err) {
      console.warn('Could not save memory:', err.message);
    }
  }

  /**
   * Record successful execution
   */
  recordSuccess(prompt, keywords, strategy) {
    this.memory.executions.push({
      timestamp: Date.now(),
      prompt: prompt.substring(0, 100),
      keywords,
      strategy,
      success: true
    });
    this.memory.successCount++;
    this.maintainSize();
    this.save();
  }

  /**
   * Record failed execution
   */
  recordFailure(prompt, keywords, error) {
    this.memory.executions.push({
      timestamp: Date.now(),
      prompt: prompt.substring(0, 100),
      keywords,
      error: error.substring(0, 100),
      success: false
    });
    this.memory.failureCount++;
    this.maintainSize();
    this.save();
  }

  /**
   * Find similar past attempts
   */
  findSimilar(keywords, limit = 3) {
    return this.memory.executions
      .filter(exec => 
        keywords.some(kw => exec.keywords?.includes(kw))
      )
      .slice(-limit);
  }

  /**
   * Calculate success rate for keyword
   */
  getSuccessRate(keyword) {
    const matches = this.memory.executions.filter(e => 
      e.keywords?.includes(keyword)
    );
    if (matches.length === 0) return 0;
    const successes = matches.filter(m => m.success).length;
    return Math.round((successes / matches.length) * 100);
  }

  /**
   * Get most successful strategy
   */
  getBestStrategy(keyword) {
    const matches = this.memory.executions.filter(e => 
      e.keywords?.includes(keyword) && e.success && e.strategy
    );
    if (matches.length === 0) return null;
    
    const strategies = {};
    matches.forEach(m => {
      strategies[m.strategy] = (strategies[m.strategy] || 0) + 1;
    });
    
    return Object.entries(strategies).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }

  /**
   * Extract keywords from text
   */
  extractKeywords(text) {
    const words = text.toLowerCase().split(/\s+/);
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'is', 'are', 'was', 'were', 'be', 'have', 'has', 'do', 'does', 'did'
    ]);
    return words.filter(w => w.length > 3 && !stopWords.has(w)).slice(0, 5);
  }

  /**
   * Assess complexity (1-10)
   */
  assessComplexity(text) {
    const factors = {
      length: Math.min(text.length / 100, 3),
      keywords: (text.match(/\b(complex|difficult|error|debug|fix|issue|analyze)\b/gi) || []).length,
      codeBlocks: (text.match(/```/g) || []).length * 2
    };
    return Math.min(Math.round(Object.values(factors).reduce((a, b) => a + b, 0)), 10);
  }

  /**
   * Get overall stats
   */
  getStats() {
    return {
      totalExecutions: this.memory.executions.length,
      successCount: this.memory.successCount,
      failureCount: this.memory.failureCount,
      successRate: this.memory.successCount + this.memory.failureCount > 0
        ? Math.round((this.memory.successCount / (this.memory.successCount + this.memory.failureCount)) * 100)
        : 0,
      memorySize: this.memory.executions.length
    };
  }

  /**
   * Keep only last 100 executions for performance
   */
  maintainSize() {
    if (this.memory.executions.length > 100) {
      this.memory.executions = this.memory.executions.slice(-100);
    }
  }

  /**
   * Clear old executions (older than 30 days)
   */
  clearOldData() {
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    this.memory.executions = this.memory.executions.filter(
      e => e.timestamp > thirtyDaysAgo
    );
    this.save();
  }
}

module.exports = MemorySystem;
