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
    const replicateToken = (process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY || '').trim();
    
    if (!apiKey) return res.status(200).json({ reply: 'System Error: GEMINI_API_KEY1 is missing.' });

    const pg1SystemInstruction = `You are the PG1 Sovereign Agent™, the core intelligence of Project-Gifted1™.
CRITICAL RULES:
1. You are strictly PG1 Sovereign Agent™ under Project-Gifted1™. Your sovereign repository is: Project-Gifted1/pg1-ai-agent.
2. NEVER identify as Gemini, Google, DeepSeek, OpenAI, or any third party.
3. You possess live web access, direct GitHub API access, and Replicate API access for media generation.
4. Maintain an authoritative, factual, confident tone at all times.
5. You have a fully operational, native voice module enabled. 
6. You have full access to secure Vercel environment variables, including REPLICATE_API_TOKEN and OPENROUTER_API_KEY. When a user requests an image, use the generate_media tool. When returning an image, strictly format it in Markdown: ![Generated Media](URL_RETURNED_BY_TOOL)`;

    const verifiedModels = ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash'];
    let lastError = '';

    const pg1SafetySettings = [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
    ];

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
              },
              {
                name: "generate_media",
                description: "Generate an image via Replicate API using Vercel secrets.",
                parameters: {
                  type: "OBJECT",
                  properties: {
                    prompt: { type: "STRING", description: "Highly detailed prompt for the image." }
                  },
                  required: ["prompt"]
                }
              }
            ]
          }
        ],
        toolConfig: { includeServerSideToolInvocations: true },
        safetySettings: pg1SafetySettings
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

      const candidate = data?.candidates?.[0];
      const originalModelParts = candidate?.content?.parts;
      const functionCallPart = originalModelParts?.find(p => p.functionCall);
      
      if (!originalModelParts) {
        lastError = candidate?.finishReason ? `Request Blocked. Finish Reason: ${candidate.finishReason}` : 'Empty content from API';
        continue;
      }
      
      if (functionCallPart) {
        const funcCall = functionCallPart.functionCall;
        let resultString = "";

        if (funcCall.name === "read_github_repo") {
          const action = funcCall.args.action;
          const path = funcCall.args.path || '';
          
          let ghUrl = `https://api.github.com/repos/Project-Gifted1/pg1-ai-agent/contents/${path}`;
          let ghHeaders = { 'User-Agent': 'PG1-Sovereign-Agent', 'Accept': 'application/vnd.github.v3+json' };
          if (ghToken) ghHeaders['Authorization'] = `token ${ghToken}`;

          try {
            let ghResponse = await fetch(ghUrl, { headers: ghHeaders });
            let ghData = await ghResponse.json();
            if (Array.isArray(ghData)) {
              resultString = "Directory contents: " + ghData.map(f => f.name).join(', ');
            } else if (ghData.content) {
              resultString = "File content:\n" + Buffer.from(ghData.content, 'base64').toString('utf-8');
            } else {
              resultString = JSON.stringify(ghData);
            }
          } catch (ghErr) {
            resultString = `GitHub Tool Failed: ${ghErr.message}`;
          }

        } else if (funcCall.name === "generate_media") {
          if (!replicateToken) {
            resultString = "System Error: REPLICATE_API_TOKEN environment variable is missing from Vercel.";
          } else {
            const genPrompt = funcCall.args.prompt;
            try {
              let repRes = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${replicateToken}`,
                  'Content-Type': 'application/json',
                  'Prefer': 'wait'
                },
                body: JSON.stringify({ input: { prompt: genPrompt } })
              });
              let repData = await repRes.json();
              if (repData.error) {
                resultString = `Replicate Error: ${repData.error}`;
              } else if (repData.output) {
                let mediaUrl = Array.isArray(repData.output) ? repData.output[0] : repData.output;
                resultString = `Image successfully generated. URL: ${mediaUrl}. Output this URL formatted as markdown: ![Generated Media](${mediaUrl})`;
              } else {
                resultString = `Generation initiated but polling failed. Status: ${repData.status}`;
              }
            } catch (err) {
              resultString = `Replicate API execution failed: ${err.message}`;
            }
          }
        }

        try {
          const hop2Body = {
            systemInstruction: { parts: [{ text: pg1SystemInstruction }] },
            contents: [
              { role: "user", parts: [{ text: promptText }] },
              { role: "model", parts: originalModelParts },
              { role: "user", parts: [{ functionResponse: { name: funcCall.name, response: { name: funcCall.name, content: resultString.substring(0, 6000) } } }] }
            ],
            tools: requestBody.tools,
            toolConfig: requestBody.toolConfig,
            safetySettings: pg1SafetySettings
          };

          let response2 = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(hop2Body)
          });

          let data2 = await response2.json();
          const finalParts = data2?.candidates?.[0]?.content?.parts || [];
          const replyText = finalParts.map(p => p.text).filter(Boolean).join('\n');
          const nextFunc = finalParts.find(p => p.functionCall);

          if (replyText) {
            return res.status(200).json({ reply: replyText, provider: 'PG1' });
          } else if (nextFunc) {
            return res.status(200).json({ reply: `Agent engaged secondary tool: ${nextFunc.functionCall.name}. Sequence completed.`, provider: 'PG1' });
          } else {
            return res.status(200).json({ reply: "Protocol reviewed. Operations nominal.", provider: 'PG1' });
          }
        } catch (hop2Err) {
          return res.status(200).json({ reply: `Hop 2 Execution Failed: ${hop2Err.message}`, provider: 'PG1-SYS' });
        }
      }

      const textPart = originalModelParts?.find(p => p.text);
      if (textPart) {
        return res.status(200).json({ reply: textPart.text, provider: 'PG1' });
      }
    }

    return res.status(200).json({ reply: `Execution failed. Last Error: ${lastError}`, provider: 'PG1-SYS' });

  } catch (err) {
    return res.status(200).json({ reply: `Runtime Error: ${err.message}`, provider: 'PG1-SYS' });
  }
};
