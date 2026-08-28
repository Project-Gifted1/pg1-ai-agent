/**
 * Self-Healing Engine Module
 * Autonomous error recovery with multiple strategies
 */

class SelfHealingEngine {
  constructor(geminiClient, githubTools, diagnosticEngine) {
    this.geminiClient = geminiClient;
    this.githubTools = githubTools;
    this.diagnosticEngine = diagnosticEngine;
    this.maxFunctionCalls = 10;
    this.maxSelfHealAttempts = 3;
  }

  async executeWithFunctionCalls(
    prompt,
    systemInstruction,
    tools,
    options = {}
  ) {
    const conversationHistory = [];
    const thinkingLog = [];
    let functionCallCount = 0;

    try {
      let response = await this.geminiClient.sendRequest(
        prompt,
        systemInstruction,
        tools,
        options
      );

      while (functionCallCount < this.maxFunctionCalls) {
        const text = this.geminiClient.extractText(response);
        if (text) {
          return {
            success: true,
            text,
            thinking: thinkingLog,
            functionCalls: functionCallCount
          };
        }

        const functionCall = this.geminiClient.extractFunctionCall(response);
        if (!functionCall) break;

        const { name, args } = functionCall.functionCall;
        functionCallCount++;

        thinkingLog.push({
          step: functionCallCount,
          function: name,
          args: this.sanitizeArgs(args)
        });

        const result = await this.executeFunction(name, args);
        
        thinkingLog[thinkingLog.length - 1].result = result.status;

        const functionResponse = {
          name,
          response: result.data
        };

        conversationHistory.push({
          parts: response.candidates[0].content.parts
        });
        conversationHistory.push({
          parts: [{ functionResponse }]
        });

        response = await this.geminiClient.continueWithFunctionResponse(
          prompt,
          systemInstruction,
          conversationHistory,
          functionResponse,
          tools,
          options
        );
      }

      if (functionCallCount >= this.maxFunctionCalls) {
        throw new Error('Maximum function call limit reached');
      }

      return {
        success: false,
        error: 'No text response generated',
        thinking: thinkingLog
      };
    } catch (err) {
      return {
        success: false,
        error: err.message,
        thinking: thinkingLog,
        functionCalls: functionCallCount
      };
    }
  }

  async executeFunction(name, args) {
    try {
      let result;

      switch (name) {
        case 'list_github_directory':
          result = await this.githubTools.listDirectory(args.path || '');
          return { status: result.success ? 'success' : 'error', data: result };

        case 'read_github_file':
          result = await this.githubTools.readFile(args.filepath);
          return { status: result.success ? 'success' : 'error', data: result };

        case 'diagnose_error':
          result = this.diagnosticEngine.diagnose(args.error_message, args.context || '');
          return { status: 'success', data: result };

        case 'validate_solution':
          result = this.diagnosticEngine.validateSolution(
            args.solution,
            args.validation_type || 'syntax'
          );
          return { status: 'success', data: result };

        default:
          return { 
            status: 'error', 
            data: { error: `Unknown function: ${name}` } 
          };
      }
    } catch (err) {
      return {
        status: 'error',
        data: { error: `Function execution failed: ${err.message}` }
      };
    }
  }

  async attemptRecovery(error, originalPrompt, systemInstruction, tools, attempt = 1) {
    if (attempt > this.maxSelfHealAttempts) {
      return null;
    }

    const backoffMs = 1000 * Math.pow(2, attempt - 1);
    await new Promise(r => setTimeout(r, backoffMs));

    if (attempt === 1) {
      try {
        const result = await this.geminiClient.sendRequest(
          `${originalPrompt}\n\nPrevious attempt failed. Please try a different approach.`,
          systemInstruction,
          tools,
          { temperature: 0.9, topP: 1.0 }
        );

        const text = this.geminiClient.extractText(result);
        if (text) return { text, strategy: 'adaptive_temperature', attempt };
      } catch (err) {
        console.error('Recovery attempt 1 failed:', err.message);
      }
    }

    if (attempt === 2) {
      try {
        const simplified = this.simplifyPrompt(originalPrompt);
        const result = await this.geminiClient.sendRequest(
          simplified,
          systemInstruction,
          tools,
          { temperature: 0.5 }
        );

        const text = this.geminiClient.extractText(result);
        if (text) return { text, strategy: 'prompt_simplification', attempt };
      } catch (err) {
        console.error('Recovery attempt 2 failed:', err.message);
      }
    }

    if (attempt === 3) {
      try {
        const result = await this.geminiClient.sendRequest(
          originalPrompt,
          systemInstruction,
          tools,
          { temperature: 0.7, model: 'gemini-2.5-flash' }
        );

        const text = this.geminiClient.extractText(result);
        if (text) return { text, strategy: 'model_fallback', attempt };
      } catch (err) {
        console.error('Recovery attempt 3 failed:', err.message);
      }
    }

    return null;
  }

  simplifyPrompt(prompt) {
    const lines = prompt.split('\n');
    const coreLines = lines.filter(l => 
      !l.includes('[') && !l.includes('INSTRUCTION') && l.trim().length > 0
    );
    return coreLines.slice(0, Math.ceil(coreLines.length / 2)).join('\n');
  }

  sanitizeArgs(args) {
    return Object.entries(args).reduce((acc, [key, value]) => {
      if (typeof value === 'string' && value.length > 100) {
        acc[key] = value.substring(0, 100) + '...';
      } else {
        acc[key] = value;
      }
      return acc;
    }, {});
  }

  generateFallbackResponse(originalPrompt, context) {
    if (originalPrompt.includes('create') || originalPrompt.includes('generate')) {
      return `I can help you create this. Here's a structured template:\n\n## Structure\n\`\`\`\n// Define your requirements\n// Configure settings\n// Implement logic\n\`\`\`\n\n## Next Steps\n1. Customize with your specific needs\n2. Test the implementation\n3. Validate output format\n\nPlease provide specific details so I can tailor this further.`;
    }

    if (originalPrompt.includes('analyze') || originalPrompt.includes('review')) {
      return `I can analyze this for you. To provide the best analysis, please share:\n\n1. Specific files or code sections to review\n2. What aspects are most important\n3. Any known issues or concerns\n4. Target requirements\n\nOnce you provide these details, I can do a thorough analysis.`;
    }

    if (originalPrompt.includes('debug') || originalPrompt.includes('fix')) {
      return `I can help debug this. To get to the root cause quickly:\n\n1. Share the complete error message\n2. Describe what you were trying to do\n3. Show the relevant code section\n4. Provide any recent changes\n\nWith this information, I can identify the issue and suggest a fix.`;
    }

    return `I encountered a challenge with this request. Here's how we can proceed:\n\n1. **Simplify**: Break the task into smaller steps\n2. **Clarify**: Provide additional context or examples\n3. **Provide Data**: Share relevant code, errors, or logs\n4. **Escalate**: If needed, I can prepare a detailed report\n\nWhich approach works best for you?`;
  }
}

module.exports = SelfHealingEngine;