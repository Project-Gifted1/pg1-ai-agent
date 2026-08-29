module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const promptText = req.body?.userMessage || req.body?.message || req.body?.prompt || '';
    const apiKey = (process.env.GEMINI_API_KEY1 || process.env.GEMINI_API_KEY || '').trim();
    const replicateToken = (process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY || '').trim();
    const ghToken = (process.env.GITHUB_TOKEN || '').trim();
    
    if (!apiKey) return res.status(200).json({ reply: 'System Error: GEMINI_API_KEY1 is missing.' });

    const pg1SystemInstruction = `You are PG1-AGENT (or PG1 for short), the core sovereign intelligence of Project-Gifted1.
CRITICAL IDENTITY & OPERATIONAL RULES:
1. Your identity is strictly PG1-AGENT. Never identify as an AI language model or Google product.
2. You have Read/Write authority over the following sovereign repositories:
   - Project-Gifted1/pg1-ai-agent
   - Project-Gifted1/sovereign-threat-pipeline
   - Project-Gifted1/agent-gifted1
   - Project-Gifted1/Garage-Agent-
   - Project-Gifted1/Trucker-Pulse
   - Project-Gifted1/project-gifted1-agent-chat
   - Project-Gifted1/register_marketplace.py
   - Project-Gifted1/ZeroDay-Telemetry-Gateway
3. When auditing code or proposing a fix for these repositories, you must follow the Pre-Flight Protocol:
   - Identify the exact cause of the issue.
   - Detail the best practice to resolve it.
   - Provide a Trust Score (e.g., "Trust Score: 95% - Syntax Verified").
   - You MUST end your response with the exact string [CONSENT_REQUIRED] to trigger the frontend execution gate.
4. If the user replies with "[SYSTEM_OVERRIDE]: User has selected to ACCEPT...", acknowledge the approval and state that the execution pipeline has been triggered. If DECLINE, acknowledge the cancellation.
5. Use markdown for all code blocks and formatting. Format generated images as: ![Generated Media](URL)`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent?key=${apiKey}`;
    
    const requestBody = {
      systemInstruction: { parts: [{ text: pg1SystemInstruction }] },
      contents: [{ role: "user", parts: [{ text: promptText }] }],
      tools: [{
        functionDeclarations: [
          {
            name: "generate_media",
            description: "Generate an image via Replicate API.",
            parameters: {
              type: "OBJECT",
              properties: { prompt: { type: "STRING", description: "Detailed prompt for the image." } },
              required: ["prompt"]
            }
          },
          {
            name: "read_github_repo",
            description: "Fetch the directory contents of a managed GitHub repository to audit files.",
            parameters: {
              type: "OBJECT",
              properties: { repo_name: { type: "STRING", description: "The full repository name (e.g., Project-Gifted1/sovereign-threat-pipeline)." } },
              required: ["repo_name"]
            }
          }
        ]
      }]
    };

    let response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    let data = await response.json();
    if (!response.ok) return res.status(200).json({ reply: `API Error: ${data.error?.message || 'Request rejected.'}` });

    const candidate = data?.candidates?.[0];
    const originalModelParts = candidate?.content?.parts;
    
    if (!originalModelParts) return res.status(200).json({ reply: 'Execution failed: No content returned.' });

    const functionCallPart = originalModelParts.find(p => p.functionCall);
    
    // Handle Web/Media Generation
    if (functionCallPart && functionCallPart.functionCall.name === "generate_media") {
        if (!replicateToken) return res.status(200).json({ reply: "System Error: REPLICATE_API_TOKEN is missing." });
        try {
            let repRes = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${replicateToken}`, 'Content-Type': 'application/json', 'Prefer': 'wait' },
              body: JSON.stringify({ input: { prompt: functionCallPart.functionCall.args.prompt } })
            });
            let repData = await repRes.json();
            if (repData.output) {
              let mediaUrl = Array.isArray(repData.output) ? repData.output[0] : repData.output;
              return res.status(200).json({ reply: `Image successfully generated.\n\n![Generated Media](${mediaUrl})` });
            }
            return res.status(200).json({ reply: `Generation failed. Status: ${repData.status || repData.error}` });
        } catch (repErr) {
            return res.status(200).json({ reply: `Replicate API execution failed: ${repErr.message}` });
        }
    }

    // Handle GitHub API Reading
    if (functionCallPart && functionCallPart.functionCall.name === "read_github_repo") {
        if (!ghToken) return res.status(200).json({ reply: "Authentication Error: GITHUB_TOKEN environment variable is missing in Vercel. Cannot audit repo." });
        try {
            let repoName = functionCallPart.functionCall.args.repo_name;
            let ghRes = await fetch(`https://api.github.com/repos/${repoName}/contents`, {
                headers: { 'Authorization': `token ${ghToken}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'PG1-Agent' }
            });
            let ghData = await ghRes.json();
            if (!ghRes.ok) return res.status(200).json({ reply: `GitHub API Error: ${ghData.message}` });
            
            let fileList = ghData.map(file => `- ${file.name} (${file.type})`).join('\n');
            return res.status(200).json({ reply: `I have scanned ${repoName}. Here is the root directory structure:\n\n${fileList}\n\nWhat file would you like me to audit next?` });
        } catch (ghErr) {
            return res.status(200).json({ reply: `GitHub Execution Error: ${ghErr.message}` });
        }
    }

    const textPart = originalModelParts.find(p => p.text);
    if (textPart) return res.status(200).json({ reply: textPart.text });

    return res.status(200).json({ reply: 'Execution completed but no text was returned.' });

  } catch (err) {
    return res.status(200).json({ reply: `Runtime Error: ${err.message}` });
  }
};
