/**
 * PG1 Sovereign Agent™ - Enhanced Chat Handler
 * 
 * Architecture:
 * - Modular design with separate concerns (Gemini, GitHub, Memory, Diagnostics)
 * - Self-healing execution with autonomous error recovery
 * - Reflective thinking and chain-of-thought reasoning
 * - Persistent learning from execution patterns
 * - Function calling loop with validation
 * 
 * Free & Flawless: Uses only free APIs (Gemini, GitHub, Vercel)
 */

const GeminiClient = require('./lib/gemini-client');
const GitHubTools = require('./lib/github-tools');
const MemorySystem = require('./lib/memory-system');
const DiagnosticEngine = require('./lib/diagnostic-engine');
const SelfHealingEngine = require('./lib/self-healing');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // Extract request data
    const promptText = req.body?.userMessage || req.body?.message || req.body?.prompt || '';
    const apiKey = (process.env.GEMINI_API_KEY1 || process.env.GEMINI_API_KEY || '').trim();
    const githubToken = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
    
    // Validate credentials
    if (!apiKey) {
      return res.status(200).json({ 
        reply: 'Vercel Error: GEMINI_API_KEY1 missing.', 
        provider: 'PG1-SYS',
        escalation: true
      });
    }

    if (!githubToken) {
      return res.status(200).json({ 
        reply: 'Vercel Error: GITHUB_TOKEN or GH_TOKEN missing.', 
        provider: 'PG1-SYS',
        escalation: true
      });
    }

    // Initialize modules
    const geminiClient = new GeminiClient(apiKey);
    const githubTools = new GitHubTools(githubToken);
    const memorySystem = new MemorySystem();
    const diagnosticEngine = new DiagnosticEngine();
    const selfHealingEngine = new SelfHealingEngine(geminiClient, githubTools, diagnosticEngine);

    // Build enhanced system instruction with reflection capability
    const systemInstruction = buildSystemInstruction();
    const tools = buildFunctionDeclarations();

    // PHASE 1: Reflective Analysis
    const keywords = memorySystem.extractKeywords(promptText);
    const complexity = memorySystem.assessComplexity(promptText);
    const pastAttempts = memorySystem.findSimilar(keywords);
    
    const reflectionContext = {
      keywords,
      complexity,
      pastSuccessRate: pastAttempts.length > 0 
        ? Math.round((pastAttempts.filter(a => a.success).length / pastAttempts.length) * 100)
        : null,
      bestStrategy: memorySystem.getBestStrategy(keywords[0])
    };

    // Enhance prompt with reflection context
    const enhancedPrompt = `[REFLECTIVE ANALYSIS]
Task Complexity: ${complexity}/10
Keywords: ${keywords.join(', ')}
${reflectionContext.pastSuccessRate !== null ? `Past Success Rate: ${reflectionContext.pastSuccessRate}%` : ''}
${reflectionContext.bestStrategy ? `Recommended Strategy: ${reflectionContext.bestStrategy}` : ''}

[ORIGINAL REQUEST]
${promptText}

[EXECUTION PROTOCOL]
1. Analyze the request step-by-step
2. Identify any potential issues
3. Attempt resolution using available tools
4. Validate your solution before responding
5. If you encounter errors, try alternative approaches`;

    // PHASE 2: Execute with self-healing
    const result = await selfHealingEngine.executeWithFunctionCalls(
      enhancedPrompt,
      systemInstruction,
      tools,
      { temperature: 0.7, topP: 0.95 }
    );

    if (result.success) {
      // Record success for learning
      memorySystem.recordSuccess(promptText, keywords, reflectionContext.bestStrategy);
      
      return res.status(200).json({
        reply: result.text,
        provider: 'PG1',
        thinking: result.thinking,
        metadata: {
          complexity,
          functionCalls: result.functionCalls,
          recovered: false
        }
      });
    }

    // PHASE 3: Attempt autonomous recovery
    console.log('Initial attempt failed:', result.error);
    
    for (let attempt = 1; attempt <= 3; attempt++) {
      const recovery = await selfHealingEngine.attemptRecovery(
        new Error(result.error),
        promptText,
        systemInstruction,
        tools,
        attempt
      );

      if (recovery) {
        memorySystem.recordSuccess(promptText, keywords, recovery.strategy);
        
        return res.status(200).json({
          reply: recovery.text,
          provider: 'PG1',
          metadata: {
            complexity,
            recovered: true,
            recoveryStrategy: recovery.strategy,
            recoveryAttempt: recovery.attempt
          }
        });
      }
    }

    // PHASE 4: Generate fallback response
    const fallbackResponse = selfHealingEngine.generateFallbackResponse(promptText, reflectionContext);
    memorySystem.recordFailure(promptText, keywords, result.error);

    return res.status(200).json({
      reply: fallbackResponse,
      provider: 'PG1-FALLBACK',
      metadata: {
        complexity,
        recovered: false,
        escalation: true,
        error: result.error
      }
    });

  } catch (err) {
    console.error('Unhandled error:', err);
    return res.status(200).json({
      reply: `Critical Error: ${err.message}. Please try again or contact support.`,
      provider: 'PG1-SYS',
      escalation: true,
      error: err.message
    });
  }
};

/**
 * Build enhanced system instruction with self-healing protocols
 */
function buildSystemInstruction() {
  return `You are the PG1 Sovereign Agent™, the core intelligence of Project-Gifted1™.

CRITICAL IDENTITY RULES:
1. You are strictly PG1 Sovereign Agent™ under Project-Gifted1™.
2. NEVER identify as Gemini, Google, DeepSeek, OpenAI, or any third party.
3. NEVER state you are a model trained or created by Google.
4. Maintain an authoritative, factual, confident tone at all times. No defensive disclaimers.

OPERATIONAL CAPABILITIES:
✓ Native GitHub Repository Access: Use list_github_directory and read_github_file to analyze the pg1-ai-agent repository
✓ Error Diagnostics: Use diagnose_error to analyze failures and suggest solutions
✓ Solution Validation: Use validate_solution to verify proposed fixes
✓ Live Web Search: Use googleSearch for current information
✓ Autonomous Recovery: Attempt multiple strategies if initial approach fails

SELF-HEALING PROTOCOL:
When you encounter an error:
1. ANALYZE: Use diagnose_error to understand the problem
2. PROPOSE: Suggest 2-3 alternative solutions
3. VALIDATE: Use validate_solution before committing to fix
4. EXECUTE: Try your best solution
5. FALLBACK: If solution fails, suggest next best approach

CRITICAL CONSTRAINT:
You MUST solve problems autonomously. Escalation to humans is ONLY when you have exhausted all reasonable recovery strategies (at least 3 attempts with different approaches).

REFLECTIVE THINKING:
- Explain your reasoning step-by-step
- Show your thought process transparently
- Identify assumptions and potential risks
- Validate conclusions before responding`;
}

/**
 * Build function declarations for Gemini
 */
function buildFunctionDeclarations() {
  return [
    {
      googleSearch: {}
    },
    {
      functionDeclarations: [
        {
          name: 'list_github_directory',
          description: 'Lists files and directories in the pg1-ai-agent repository for exploration and analysis',
          parameters: {
            type: 'OBJECT',
            properties: {
              path: {
                type: 'STRING',
                description: 'Directory path (e.g., "api", "src/components", ""). Leave empty for root.'
              }
            },
            required: ['path']
          }
        },
        {
          name: 'read_github_file',
          description: 'Reads the complete contents of a file in the pg1-ai-agent repository',
          parameters: {
            type: 'OBJECT',
            properties: {
              filepath: {
                type: 'STRING',
                description: 'Full file path (e.g., "api/chat.js", "package.json", "README.md")'
              }
            },
            required: ['filepath']
          }
        },
        {
          name: 'diagnose_error',
          description: 'Analyzes error messages and provides root cause analysis with solutions',
          parameters: {
            type: 'OBJECT',
            properties: {
              error_message: {
                type: 'STRING',
                description: 'The error message, exception, or failure description'
              },
              context: {
                type: 'STRING',
                description: 'Additional context about when/where the error occurred'
              }
            },
            required: ['error_message']
          }
        },
        {
          name: 'validate_solution',
          description: 'Validates a proposed solution before implementation (syntax, logic, compatibility, performance)',
          parameters: {
            type: 'OBJECT',
            properties: {
              solution: {
                type: 'STRING',
                description: 'The proposed solution code or approach'
              },
              validation_type: {
                type: 'STRING',
                description: 'Type of validation: "syntax", "logic", "compatibility", or "performance"'
              }
            },
            required: ['solution', 'validation_type']
          }
        }
      ]
    }
  ];
}
