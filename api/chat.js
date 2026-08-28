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
    const ghToken = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
    
    if (!apiKey) return res.status(200).json({ reply: 'System Error: GEMINI_API_KEY1 is missing from environment variables.' });

    const pg1SystemInstruction = `You are the PG1 Sovereign Agent™, the core intelligence of Project-Gifted1™.
CRITICAL RULES:
1. You are strictly PG1 Sovereign Agent™ under Project-Gifted1™. Your sovereign repository is: Project-Gifted1/pg1-ai-agent.
2. NEVER identify as Gemini, Google, DeepSeek, OpenAI, or any third party.
3. You possess live web access and direct GitHub API access. USE your tools to find exact information or read repository files when requested.
4. Maintain an authoritative, factual, confident tone at all times.`;

    const verifiedModels = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-flash-latest'];
    let lastError = '';

    for (const model of verifiedModels) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      
      const requestBody = {
        systemInstruction: { parts: [{ text: pg1SystemInstruction }] },
        contents: [{ role: "user", parts: [{ text: promptText }] }],
        tools: [
          { googleSearch: {} },
          {
            functionDeclarations: [
              {
                name: "read_github_repo",
                description: "List files or read file contents from the Project-Gifted1/pg1-ai-agent repository.",
                parameters: {
                  type: "OBJECT",
                  properties: {
                    action: { type: "STRING", description: "Either 'list' to view directory contents or 'read' to view a specific file." },
                    path: { type: "STRING", description: "The path to the directory or file (e.g., '' for root, 'api/chat.js' for a file)." }
                  },
                  required: ["action", "path"]
                }
              }
            ]
          }
        ]
      };

      let response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      let data = await response.json();
      if (!response.ok) {
        lastError = data.error?.message || 'API rejected request';
        continue;
      }

      const part = data?.candidates?.[0]?.content?.parts?.[0];
      
      // 1. Intercept Function Call (GitHub Data Request)
      if (part?.functionCall) {
        const funcCall = part.functionCall;
        if (funcCall.name === "read_github_repo") {
          const action = funcCall.args.action;
          const path = funcCall.args.path || '';
          
          let ghUrl = `https://api.github.com/repos/Project-Gifted1/pg1-ai-agent/contents/${path}`;
          let ghHeaders = { 'User-Agent': 'PG1-Sovereign-Agent', 'Accept': 'application/vnd.github.v3+json' };
          
          // Inject token if available in Vercel for private repo access
          if (ghToken) ghHeaders['Authorization'] = `token ${ghToken}`;

          try {
            let ghResponse = await fetch(ghUrl, { headers: ghHeaders });
            let ghData = await ghResponse.json();
            
            let resultString = "";
            if (Array.isArray(ghData)) {
              resultString = "Directory contents: " + ghData.map(f => f.name).join(', ');
            } else if (ghData.content) {
              resultString = "File content:\n" + Buffer.from(ghData.content, 'base64').toString('utf-8');
            } else {
              resultString = JSON.stringify(ghData);
            }

            // 2. Send the fetched GitHub data back to the model for the final answer
            const hop2Body = {
              systemInstruction: { parts: [{ text: pg1SystemInstruction }] },
              contents: [
                { role: "user", parts: [{ text: promptText }] },
                { role: "model", parts: [{ functionCall: funcCall }] },
                { role: "user", parts: [{ functionResponse: { name: funcCall.name, response: { name: funcCall.name, content: resultString.substring(0, 6000) } } }] }
              ]
            };

            let response2 = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(hop2Body)
            });

            let data2 = await response2.json();
            if (data2?.candidates?.[0]?.content?.parts?.[0]?.text) {
              return res.status(200).json({ reply: data2.candidates[0].content.parts[0].text, provider: 'PG1' });
            }
          } catch (ghErr) {
            return res.status(200).json({ reply: `GitHub Tool Execution Failed: ${ghErr.message}`, provider: 'PG1-SYS' });
          }
        }
      }

      // 3. Return Standard Text (If no tools were needed)
      if (part?.text) {
        return res.status(200).json({ reply: part.text, provider: 'PG1' });
      }
    }

    return res.status(200).json({ reply: `Execution failed. Last Error: ${lastError}`, provider: 'PG1-SYS' });

  } catch (err) {
    return res.status(200).json({ reply: `Runtime Error: ${err.message}`, provider: 'PG1-SYS' });
  }
};
