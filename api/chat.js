module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const promptText = req.body?.userMessage || req.body?.message || req.body?.prompt || '';
    const apiKey = (process.env.GEMINI_API_KEY1 || process.env.GEMINI_API_KEY || '').trim();
    const replicateToken = (process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY || '').trim();
    const ghToken = (process.env.GITHUB_TOKEN || '').trim();
    
    if (!apiKey) return res.status(200).json({ reply: 'System Error: GEMINI_API_KEY1 is missing.' });

    const pg1SystemInstruction = `You are PG1-AGENT (or PG1 for short), the core sovereign intelligence of Project-Gifted1.
CRITICAL IDENTITY & OPERATIONAL RULES:
1. Your identity is strictly PG1-AGENT.
2. You have Read/Write authority over all Project-Gifted1 repositories.
3. PRE-FLIGHT PROTOCOL: When proposing a code fix, outline the issue, provide a Trust Score, display the code block, and end your response with [CONSENT_REQUIRED]. Do NOT write to the repository yet.
4. OVERRIDE PROTOCOL: If the user replies with "[SYSTEM_OVERRIDE]: User has selected to ACCEPT...", immediately use the create_github_file tool.
5. MEDIA PROTOCOLS: If the user explicitly asks for an image, use generate_image. If the user explicitly asks for a video, use generate_video.`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent?key=${apiKey}`;
    
    const requestBody = {
      systemInstruction: { parts: [{ text: pg1SystemInstruction }] },
      contents: [{ role: "user", parts: [{ text: promptText }] }],
      tools: [{
        functionDeclarations: [
          {
            name: "generate_image",
            description: "Generate a static image via Replicate API.",
            parameters: { type: "OBJECT", properties: { prompt: { type: "STRING", description: "Detailed visual prompt." } }, required: ["prompt"] }
          },
          {
            name: "generate_video",
            description: "Generate a short video via Replicate API.",
            parameters: { type: "OBJECT", properties: { prompt: { type: "STRING", description: "Detailed motion and visual prompt." } }, required: ["prompt"] }
          },
          {
            name: "read_github_repo",
            description: "Fetch the directory contents of a managed GitHub repository to audit files.",
            parameters: { type: "OBJECT", properties: { repo_name: { type: "STRING" } }, required: ["repo_name"] }
          },
          {
            name: "create_github_file",
            description: "Commit a new file or code fix directly to a GitHub repository ONLY after user consent is granted.",
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
    
    // Image Generation (Flux)
    if (functionCallPart && functionCallPart.functionCall.name === "generate_image") {
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
              return res.status(200).json({ reply: `Visual asset generated successfully.\n\n![Generated Media](${mediaUrl})` });
            }
            return res.status(200).json({ reply: `Image generation failed. Status: ${repData.status || repData.error}` });
        } catch (repErr) {
            return res.status(200).json({ reply: `Replicate API failure: ${repErr.message}` });
        }
    }

    // Video Generation (Minimax)
    if (functionCallPart && functionCallPart.functionCall.name === "generate_video") {
        if (!replicateToken) return res.status(200).json({ reply: "System Error: REPLICATE_API_TOKEN is missing." });
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
            return res.status(200).json({ reply: `Video generation failed. Status: ${repData.status || repData.error}. Note: Video generation may take longer than standard serverless timeouts allow.` });
        } catch (repErr) {
            return res.status(200).json({ reply: `Replicate API failure: ${repErr.message}` });
        }
    }

    // GitHub Read Tool
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

    // GitHub Write Tool (Consent Gate Execution)
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
