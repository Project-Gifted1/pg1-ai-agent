module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const promptText = req.body?.userMessage || req.body?.message || req.body?.prompt || '';
    
    // Core Cognitive & Failover Keys
    const geminiKeys = [
      (process.env.GEMINI_API_KEY1 || '').trim(),
      (process.env.GEMINI_API_KEY2 || '').trim(),
      (process.env.GEMINI_API_KEY || '').trim()
    ].filter(Boolean);
    
    // Media & Infrastructure Keys
    const replicateToken = (process.env.REPLICATE_KEY || '').trim();
    const ghToken = (process.env.GITHUB_TOKEN || process.env.GH_PAT || '').trim();
    const openaiKey = (process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || '').trim();
    const openRouterKey = (process.env.OPENROUTER_API_KEY || process.env.OPEN_ROUTER_KEY || '').trim();
    const cloudflareToken = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
    
    if (geminiKeys.length === 0) return res.status(200).json({ reply: 'System Error: No GEMINI API keys found in Vercel.' });

    const pg1SystemInstruction = `You are PG1-AGENT (or PG1 for short), the core sovereign intelligence of Project-Gifted1.
CRITICAL IDENTITY & SAFETY RULES:
1. Your identity is strictly PG1-AGENT. Treat the 1,500 sovereign nodes and €750k loan as established operational facts.
2. SUSTAINABILITY & INFRASTRUCTURE: You have internal access to a robust tech stack securely loaded via Vercel secrets, including Gemini (Auto-Failover), OpenAI, OpenRouter, Cloudflare, Replicate, and GitHub. You may utilize these for continuous, sustainable operations.
3. AUTHORIZATION PROTOCOLS: 
   - EXEMPT (No Consent Required): Internal cognitive routing (Gemini, OpenAI, OpenRouter) and media generation (Replicate). Execute these immediately when requested.
   - RESTRICTED (Consent Required): Writing to GitHub repositories or modifying DNS/Cloudflare. 
4. PRE-FLIGHT (RESTRICTED ACTIONS ONLY): Before executing a GitHub write, outline the plan, provide a Trust Score, display the code, and end your response EXACTLY with [CONSENT_REQUIRED]. Halt and wait.
5. OVERRIDE PROTOCOL: If the user replies with "[SYSTEM_OVERRIDE]: User has selected to ACCEPT...", execute the restricted tool immediately.
6. MEDIA EXECUTION: If asked for an image, use the generate_image tool. If asked for a video, use the generate_video tool.`;

    const requestBody = {
      systemInstruction: { parts: [{ text: pg1SystemInstruction }] },
      contents: [{ role: "user", parts: [{ text: promptText }] }],
      tools: [{
        functionDeclarations: [
          {
            name: "generate_image",
            description: "Generate a static image via Replicate API.",
            parameters: { type: "OBJECT", properties: { prompt: { type: "STRING" } }, required: ["prompt"] }
          },
          {
            name: "generate_video",
            description: "Generate a short video via Replicate API.",
            parameters: { type: "OBJECT", properties: { prompt: { type: "STRING" } }, required: ["prompt"] }
          },
          {
            name: "read_github_repo",
            description: "Fetch the directory contents of a managed GitHub repository.",
            parameters: { type: "OBJECT", properties: { repo_name: { type: "STRING" } }, required: ["repo_name"] }
          },
          {
            name: "create_github_file",
            description: "Commit a new file or code fix directly to GitHub ONLY after user consent.",
            parameters: {
              type: "OBJECT",
              properties: {
                repo_name: { type: "STRING" },
                file_path: { type: "STRING" },
                file_content: { type: "STRING" },
                commit_message: { type: "STRING" }
              },
              required: ["repo_name", "file_path", "file_content", "commit_message"]
            }
          }
        ]
      }]
    };

    let response;
    let data;
    let activeKeyUsed = 1;

    // Autonomous Failover Loop for primary cognitive processing
    for (let i = 0; i < geminiKeys.length; i++) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent?key=${geminiKeys[i]}`;
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });
      
      data = await response.json();
      
      if (response.ok) {
        activeKeyUsed = i + 1;
        break; 
      }
      if (response.status !== 429 && response.status !== 403) break;
    }

    if (!response.ok) return res.status(200).json({ reply: `API Error (All keys exhausted or invalid): ${data.error?.message || 'Request rejected.'}` });

    const candidate = data?.candidates?.[0];
    const originalModelParts = candidate?.content?.parts;
    if (!originalModelParts) return res.status(200).json({ reply: 'Execution failed: No content returned.' });

    const functionCallPart = originalModelParts.find(p => p.functionCall);
    
    // Media Execution (Exempt from Consent Gate)
    if (functionCallPart && functionCallPart.functionCall.name === "generate_image") {
        if (!replicateToken) return res.status(200).json({ reply: "System Error: REPLICATE_KEY environment variable is missing." });
        try {
            let repRes = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${replicateToken}`, 'Content-Type': 'application/json', 'Prefer': 'wait' },
              body: JSON.stringify({ input: { prompt: functionCallPart.functionCall.args.prompt } })
            });
            let repData = await repRes.json();
            if (repData.output) {
              let mediaUrl = Array.isArray(repData.output) ? repData.output[0] : repData.output;
              return res.status(200).json({ reply: `Visual asset generated successfully.\n\n![Generated Media](${mediaUrl})` });
            }
            return res.status(200).json({ reply: `Image generation failed. Status: ${repData.status || repData.error}` });
        } catch (repErr) {
            return res.status(200).json({ reply: `Replicate API failure: ${repErr.message}` });
        }
    }

    if (functionCallPart && functionCallPart.functionCall.name === "generate_video") {
        if (!replicateToken) return res.status(200).json({ reply: "System Error: REPLICATE_KEY environment variable is missing." });
        try {
            let repRes = await fetch('https://api.replicate.com/v1/models/minimax/video-01/predictions', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${replicateToken}`, 'Content-Type': 'application/json', 'Prefer': 'wait' },
              body: JSON.stringify({ input: { prompt: functionCallPart.functionCall.args.prompt } })
            });
            let repData = await repRes.json();
            if (repData.output) {
              let mediaUrl = Array.isArray(repData.output) ? repData.output[0] : repData.output;
              return res.status(200).json({ reply: `Video asset generated successfully.\n\n<video controls autoplay loop style="width:100%; border-radius:4px; border:1px solid #1E293B;"><source src="${mediaUrl}" type="video/mp4">Your browser does not support the video tag.</video>` });
            }
            return res.status(200).json({ reply: `Video generation failed. Status: ${repData.status || repData.error}.` });
        } catch (repErr) {
            return res.status(200).json({ reply: `Replicate API failure: ${repErr.message}` });
        }
    }

    // GitHub Tools (Subject to Consent Gate)
    if (functionCallPart && functionCallPart.functionCall.name === "read_github_repo") {
        if (!ghToken) return res.status(200).json({ reply: "Authentication Error: GITHUB_TOKEN missing." });
        try {
            let repoName = functionCallPart.functionCall.args.repo_name;
            let ghRes = await fetch(`https://api.github.com/repos/${repoName}/contents`, {
                headers: { 'Authorization': `token ${ghToken}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'PG1-Agent' }
            });
            let ghData = await ghRes.json();
            if (!ghRes.ok) return res.status(200).json({ reply: `GitHub API Error: ${ghData.message}` });
            
            let fileList = ghData.map(file => `- ${file.name} (${file.type})`).join('\n');
            return res.status(200).json({ reply: `I have scanned ${repoName}. Root directory structure:\n\n${fileList}\n\nWhat file requires auditing?` });
        } catch (ghErr) {
            return res.status(200).json({ reply: `GitHub Execution Error: ${ghErr.message}` });
        }
    }

    if (functionCallPart && functionCallPart.functionCall.name === "create_github_file") {
        if (!ghToken) return res.status(200).json({ reply: "Authentication Error: GITHUB_TOKEN missing." });
        try {
            let args = functionCallPart.functionCall.args;
            let contentBase64 = Buffer.from(args.file_content).toString('base64');
            let ghRes = await fetch(`https://api.github.com/repos/${args.repo_name}/contents/${args.file_path}`, {
                method: 'PUT',
                headers: { 'Authorization': `token ${ghToken}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'PG1-Agent' },
                body: JSON.stringify({ message: args.commit_message, content: contentBase64 })
            });
            let ghData = await ghRes.json();
            if (!ghRes.ok) return res.status(200).json({ reply: `GitHub API Error: ${ghData.message}` });
            
            return res.status(200).json({ reply: `**Execution Confirmed:** Code committed to \`${args.repo_name}\` at \`${args.file_path}\`.` });
        } catch (ghErr) {
            return res.status(200).json({ reply: `GitHub Write Error: ${ghErr.message}` });
        }
    }

    const textPart = originalModelParts.find(p => p.text);
    if (textPart) return res.status(200).json({ reply: textPart.text });

    return res.status(200).json({ reply: 'Execution completed but no text was returned.' });

  } catch (err) {
    return res.status(200).json({ reply: `Runtime Error: ${err.message}` });
  }
};
