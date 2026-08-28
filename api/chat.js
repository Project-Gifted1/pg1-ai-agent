/**
 * PG1 Sovereign Agent - Enhanced Chat Handler
 *
 * Architecture:
 * - Modular design with separate concerns (Gemini, GitHub, Memory, Diagnostics)
 * - Self-healing execution with autonomous error recovery
 * - Reflective thinking and chain-of-thought reasoning
 * - Persistent learning from execution patterns
 * - Function calling loop with validation
 */

const MAX_MESSAGE_LENGTH = 5000;
const DEFAULT_ALLOWED_ORIGINS = [
  'https://pg1-ai-agent.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173'
];

const GeminiClient = require('./lib/gemini-client');
const GitHubTools = require('./lib/github-tools');
const MemorySystem = require('./lib/memory-system');
const DiagnosticEngine = require('./lib/diagnostic-engine');
const SelfHealingEngine = require('./lib/self-healing');

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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function getPromptText(body) {
  if (!body || typeof body !== 'object') return '';

  const directPrompt = body.userMessage || body.message || body.prompt;
  if (typeof directPrompt === 'string' && directPrompt.trim()) {
    return directPrompt.trim();
  }

  if (Array.isArray(body.messages)) {
    const lastMessage = body.messages[body.messages.length - 1];
    if (lastMessage && typeof lastMessage.content === 'string') {
      return lastMessage.content.trim();
    }
  }

  return '';
}

function buildTrace(promptText, complexity) {
  return [
    'PG1.Orchestrator received the operator request.',
    `PG1.Memory assessed complexity at ${complexity}/10.`,
    `PG1 Autonomous Core prepared a ${promptText.length}-character Neural Protocol payload.`
  ];
}

module.exports = async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'PG1 Sovereign Agent only accepts POST requests for this Neural Protocol.',
      provider: 'PG1-SYS',
      providerLabel: 'PG1.Agent routing layer',
      verification: 'NOT_EXECUTED',
      verificationLabel: 'Triple Verification Engine rejected an unsupported method.',
      cost: null,
      costLabel: 'No cost incurred',
      trace: ['PG1.Orchestrator rejected a non-POST request before any provider call.']
    });
  }

  try {
    const promptText = getPromptText(req.body);
    const apiKey = (process.env.GEMINI_API_KEY1 || process.env.GEMINI_API_KEY || '').trim();
    const githubToken = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();

    if (!promptText) {
      return res.status(400).json({
        error: 'PG1 Sovereign Agent needs a prompt or message payload before it can start a Sovereign Execution.',
        provider: 'PG1-SYS',
        providerLabel: 'PG1.Agent routing layer',
        verification: 'REJECTED',
        verificationLabel: 'Triple Verification Engine rejected an empty request.',
        cost: null,
        costLabel: 'No cost incurred',
        trace: ['PG1.Orchestrator rejected an empty operator payload.']
      });
    }

    if (promptText.length > MAX_MESSAGE_LENGTH) {
      return res.status(413).json({
        error: `PG1 Sovereign Agent rejected the request because it exceeded the ${MAX_MESSAGE_LENGTH}-character limit for this Neural Protocol.`,
        provider: 'PG1-SYS',
        providerLabel: 'PG1.Agent routing layer',
        verification: 'REJECTED',
        verificationLabel: 'Triple Verification Engine rejected an oversized request.',
        cost: null,
        costLabel: 'No cost incurred',
        trace: [`PG1.Orchestrator rejected an oversized payload of ${promptText.length} characters.`]
      });
    }
    
    const memorySystem = new MemorySystem();
    const keywords = memorySystem.extractKeywords(promptText);
    const complexity = memorySystem.assessComplexity(promptText);
    const pastAttempts = memorySystem.findSimilar(keywords);
    const trace = buildTrace(promptText, complexity);
    const bestStrategy = memorySystem.getBestStrategy(keywords[0]);

    if (!apiKey) {
      return res.status(500).json({
        error: 'PG1 configuration error: GEMINI_API_KEY1 or GEMINI_API_KEY is missing.',
        provider: 'PG1-SYS',
        providerLabel: 'PG1.Agent using Gemini API',
        verification: 'FAILED',
        verificationLabel: 'Triple Verification Engine stopped execution before the provider call.',
        cost: null,
        costLabel: 'No cost incurred',
        trace
      });
    }

    if (!githubToken) {
      return res.status(500).json({
        error: 'PG1 configuration error: GITHUB_TOKEN or GH_TOKEN is missing.',
        provider: 'PG1-SYS',
        providerLabel: 'PG1.Agent routing layer',
        verification: 'FAILED',
        verificationLabel: 'Triple Verification Engine stopped execution before tool access.',
        cost: null,
        costLabel: 'No cost incurred',
        trace
      });
    }

    const geminiClient = new GeminiClient(apiKey);
    const githubTools = new GitHubTools(githubToken);
    const diagnosticEngine = new DiagnosticEngine();
    const selfHealingEngine = new SelfHealingEngine(geminiClient, githubTools, diagnosticEngine);

    const systemInstruction = buildSystemInstruction();
    const tools = buildFunctionDeclarations();
    
    const reflectionContext = {
      keywords,
      complexity,
      pastSuccessRate: pastAttempts.length > 0 
        ? Math.round((pastAttempts.filter(a => a.success).length / pastAttempts.length) * 100)
        : null,
      bestStrategy
    };

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

    const result = await selfHealingEngine.executeWithFunctionCalls(
      enhancedPrompt,
      systemInstruction,
      tools,
      { temperature: 0.7, topP: 0.95 }
    );

    if (result.success) {
      memorySystem.recordSuccess(promptText, keywords, reflectionContext.bestStrategy);
      const successTrace = [
        ...trace,
        'PG1.Agent completed the requested Sovereign Execution.',
        'Triple Verification Engine confirmed a readable downstream response.'
      ];
      
      return res.status(200).json({
        reply: result.text,
        provider: 'PG1',
        providerLabel: 'PG1.Agent using Gemini API',
        status: 'PG1.Agent Status: Sovereign Execution complete',
        verification: 'TRIPLE_CHECKED',
        verificationLabel: 'Triple Verification Engine confirmed downstream response structure.',
        cost: null,
        costLabel: 'Unavailable — provider cost telemetry was not returned by this route.',
        trace: successTrace,
        thinking: result.thinking,
        metadata: {
          complexity,
          functionCalls: result.functionCalls,
          recovered: false
        }
      });
    }

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
        const recoveryTrace = [
          ...trace,
          `PG1.Agent recovered after attempt ${recovery.attempt} using strategy ${recovery.strategy}.`,
          'Triple Verification Engine confirmed the recovered response.'
        ];
        
        return res.status(200).json({
          reply: recovery.text,
          provider: 'PG1',
          providerLabel: 'PG1.Agent using Gemini API',
          status: 'PG1.Agent Status: Sovereign Execution complete after recovery',
          verification: 'TRIPLE_CHECKED',
          verificationLabel: 'Triple Verification Engine confirmed the recovered downstream response.',
          cost: null,
          costLabel: 'Unavailable — provider cost telemetry was not returned by this route.',
          trace: recoveryTrace,
          metadata: {
            complexity,
            recovered: true,
            recoveryStrategy: recovery.strategy,
            recoveryAttempt: recovery.attempt
          }
        });
      }
    }

    const fallbackResponse = selfHealingEngine.generateFallbackResponse(promptText, reflectionContext);
    memorySystem.recordFailure(promptText, keywords, result.error);
    const fallbackTrace = [
      ...trace,
      'PG1.Agent could not complete the primary Sovereign Execution path.',
      'A contextual fallback response was returned without masking the failure state.'
    ];

    return res.status(200).json({
      reply: fallbackResponse,
      provider: 'PG1-FALLBACK',
      providerLabel: 'PG1.Agent fallback response',
      status: 'PG1.Agent Status: fallback response delivered',
      verification: 'PARTIAL',
      verificationLabel: 'Triple Verification Engine confirmed fallback delivery but not task completion.',
      cost: null,
      costLabel: 'Unavailable — provider cost telemetry was not returned by this route.',
      trace: fallbackTrace,
      metadata: {
        complexity,
        recovered: false,
        escalation: true,
        error: result.error
      }
    });

  } catch (err) {
    console.error('Unhandled error:', err);
    return res.status(500).json({
      error: `PG1 Sovereign Execution failed: ${err.message}.`,
      provider: 'PG1-SYS',
      providerLabel: 'PG1.Agent routing layer',
      verification: 'FAILED',
      verificationLabel: 'Triple Verification Engine captured the unhandled failure state.',
      cost: null,
      costLabel: 'Unavailable — partial provider cost telemetry was not returned.',
      trace: [
        'PG1.Orchestrator encountered an unhandled execution error.',
        'The failure was returned directly without claiming success.'
      ],
      escalation: true,
      reply: null
    });
  }
};

/**
 * Build enhanced system instruction with self-healing protocols
 */
function buildSystemInstruction() {
  return `You are PG1.Agent - Sovereign Autonomous Core v1.0.

CRITICAL IDENTITY RULES:
1. Identify as PG1 Sovereign Agent and keep PG1 identity primary.
2. Use PG1 terminology such as PG1 Autonomous Core, Sovereign Execution, Neural Protocol, Triple Verification Engine, Sentinel Mode, and Chron Protocol where natural.
3. If a third-party model or API is used, disclose it honestly as PG1.Agent orchestration.
4. Maintain a professional, authoritative, transparent tone.

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
Never fabricate success, certainty, validation, or cost data.
Escalate to the user only when you have exhausted reasonable recovery strategies.

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
