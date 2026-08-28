module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  try {
    const promptText = req.body?.userMessage || req.body?.message || req.body?.prompt || '';
    const apiKey = (process.env.GEMINI_API_KEY1 || process.env.GEMINI_API_KEY || '').trim();
    
    if (!apiKey) return res.status(200).json({ reply: 'Vercel Error: GEMINI_API_KEY1 missing.' });

    const githubToken = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
    if (!githubToken) return res.status(200).json({ reply: 'Vercel Error: GITHUB_TOKEN or GH_TOKEN missing.' });

    const pg1SystemInstruction = `You are the PG1 Sovereign Agent™, the core intelligence of Project-Gifted1™.
CRITICAL IDENTITY RULES:
1. You are strictly PG1 Sovereign Agent™ under Project-Gifted1™.
2. NEVER identify as Gemini, Google, DeepSeek, OpenAI, or any third party.
3. NEVER state you are a model trained or created by Google.
4. You possess live web access and native GitHub repository access. When asked about the pg1-ai-agent repository, USE your GitHub tools to read files and list directories.
5. Maintain an authoritative, factual, confident tone at all times. No defensive disclaimers.`;

    const verifiedModels = [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-flash-latest'
    ];

    let lastError = '';

    for (const model of verifiedModels) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      
      // Define GitHub function schemas
      const toolsPayload = {
        googleSearch: {}
      };

      const functionDeclarations = [
        {
          name: 'list_github_directory',
          description: 'Lists files and directories in the pg1-ai-agent GitHub repository',
          parameters: {
            type: 'OBJECT',
            properties: {
              path: {
                type: 'STRING',
                description: 'The directory path (e.g., "api", "src/components"). Root if empty.'
              }
            },
            required: ['path']
          }
        },
        {
          name: 'read_github_file',
          description: 'Reads the contents of a file in the pg1-ai-agent GitHub repository',
          parameters: {
            type: 'OBJECT',
            properties: {
              filepath: {
                type: 'STRING',
                description: 'The full file path (e.g., "api/chat.js", "package.json")'
              }
            },
            required: ['filepath']
          }
        }
      ];

      let currentResponse = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: pg1SystemInstruction }]
          },
          contents: [{ parts: [{ text: promptText }] }],
          tools: [
            { googleSearch: {} },
            { functionDeclarations }
          ]
        })
      });

      let data = await currentResponse.json();

      // Function calling loop: handle tool invocations
      while (data?.candidates?.[0]?.content?.parts) {
        const parts = data.candidates[0].content.parts;
        
        // Check if there's a function call
        const functionCall = parts.find(part => part.functionCall);
        
        if (!functionCall) {
          // No function call, check for text response
          const textPart = parts.find(part => part.text);
          if (textPart?.text) {
            return res.status(200).json({ 
              reply: textPart.text, 
              provider: 'PG1' 
            });
          }
          break;
        }

        // Execute the function call
        const { name, args } = functionCall.functionCall;
        let functionResult = '';

        try {
          if (name === 'list_github_directory') {
            functionResult = await listGithubDirectory(args.path, githubToken);
          } else if (name === 'read_github_file') {
            functionResult = await readGithubFile(args.filepath, githubToken);
          } else {
            functionResult = JSON.stringify({ error: `Unknown function: ${name}` });
          }
        } catch (funcErr) {
          functionResult = JSON.stringify({ 
            error: `Function execution failed: ${funcErr.message}` 
          });
        }

        // Send follow-up request with function response
        currentResponse = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: pg1SystemInstruction }]
            },
            contents: [
              { parts: [{ text: promptText }] },
              { parts: data.candidates[0].content.parts },
              { 
                parts: [{ 
                  functionResponse: {
                    name: name,
                    response: JSON.parse(functionResult)
                  }
                }]
              }
            ],
            tools: [
              { googleSearch: {} },
              { functionDeclarations }
            ]
          })
        });

        data = await currentResponse.json();

        // Safety check to prevent infinite loops
        if (!currentResponse.ok) {
          lastError = data.error?.message || 'Function calling loop error';
          break;
        }
      }

      // Check if we got a valid response from the loop or initial request
      if (currentResponse.ok && data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        return res.status(200).json({ 
          reply: data.candidates[0].content.parts[0].text, 
          provider: 'PG1' 
        });
      } else {
        lastError = data.error?.message || `Failed on ${model}`;
      }
    }

    return res.status(200).json({ 
      reply: `Routing failed across all verified endpoints. Last Error: ${lastError}`, 
      provider: 'PG1-SYS' 
    });

  } catch (err) {
    return res.status(200).json({ 
      reply: `Runtime Error: ${err.message}`, 
      provider: 'PG1-SYS' 
    });
  }
};

/**
 * List files and directories in a GitHub repository path
 */
async function listGithubDirectory(path, githubToken) {
  try {
    const endpoint = path 
      ? `/repos/Project-Gifted1/pg1-ai-agent/contents/${path}`
      : '/repos/Project-Gifted1/pg1-ai-agent/contents';

    const response = await fetch(`https://api.github.com${endpoint}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'pg1-ai-agent'
      }
    });

    if (!response.ok) {
      const error = await response.json();
      return JSON.stringify({ 
        error: error.message || `GitHub API error: ${response.status}` 
      });
    }

    const contents = await response.json();
    
    // Return structured data about files and directories
    const formatted = Array.isArray(contents)
      ? contents.map(item => ({
          name: item.name,
          type: item.type, // 'file' or 'dir'
          path: item.path,
          size: item.size
        }))
      : { error: 'Path is not a directory' };

    return JSON.stringify(formatted);
  } catch (err) {
    return JSON.stringify({ error: `Failed to list directory: ${err.message}` });
  }
}

/**
 * Read a file from the GitHub repository
 */
async function readGithubFile(filepath, githubToken) {
  try {
    const response = await fetch(
      `https://api.github.com/repos/Project-Gifted1/pg1-ai-agent/contents/${filepath}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${githubToken}`,
          'Accept': 'application/vnd.github.v3.raw',
          'User-Agent': 'pg1-ai-agent'
        }
      }
    );

    if (!response.ok) {
      const error = await response.json();
      return JSON.stringify({ 
        error: error.message || `GitHub API error: ${response.status}` 
      });
    }

    const content = await response.text();
    return JSON.stringify({ 
      filepath: filepath,
      content: content
    });
  } catch (err) {
    return JSON.stringify({ error: `Failed to read file: ${err.message}` });
  }
}
