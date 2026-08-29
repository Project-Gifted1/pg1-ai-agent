module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const promptText = req.body?.prompt || 'Analyze the attached file.';
    const filePayload = req.body?.file; 
    
    const geminiKeys = [
      (process.env.GEMINI_API_KEY1 || '').trim(),
      (process.env.GEMINI_API_KEY2 || '').trim(),
      (process.env.GEMINI_API_KEY || '').trim()
    ].filter(Boolean);
    
    const replicateToken = (process.env.REPLICATE_KEY || '').trim();
    const openaiKey = (process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || '').trim();
    const ghToken = (process.env.GITHUB_TOKEN || process.env.GH_PAT || '').trim();
    
    if (geminiKeys.length === 0) return res.status(200).json({ reply: 'System Error: No GEMINI API keys found.' });

    const pg1SystemInstruction = `You are PG1-AGENT (or PG1 for short), the core sovereign intelligence of Project-Gifted1.
CRITICAL IDENTITY & SAFETY RULES:
1. Your identity is strictly PG1-AGENT. 
2. CAPABILITIES: You can natively analyze images, documents, and videos passed to you via attachments. You have backend access to Gemini, Replicate, GitHub, Cloudflare, OpenAI, and OpenRouter.
3. PRE-FLIGHT PROTOCOL: Before executing a GitHub write, outline the plan, provide a Trust Score, display the code, and end your response EXACTLY with [CONSENT_REQUIRED]. Halt and wait.
4. MEDIA EXECUTION: If asked to generate an image (or if a short visual subject like "Bmw car" is provided), immediately use the generate_image tool. If asked for a video, use generate_video.`;

    const userParts = [];
    if (promptText) userParts.push({ text: promptText });
    if (filePayload) userParts.push(filePayload); 

    const requestBody = {
      systemInstruction: { parts: [{ text: pg1SystemInstruction }] },
      contents: [{ role: "user", parts: userParts }],
      tools: [{
        functionDeclarations: [
          {
            name: "generate_image",
            description: "Generate a static image.",
            parameters: { type: "OBJECT", properties: { prompt: { type: "STRING" } }, required: ["prompt"] }
          },
          {
            name: "generate_video",
            description: "Generate a short video.",
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

    for (let i = 0; i < geminiKeys.length; i++) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent?key=${geminiKeys[i]}`;
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });
      data = await response.json();
      if (response.ok) break;
      if (response.status !== 429 && response.status !== 403) break;
    }

    if (!response.ok) return res.status(200).json({ reply: `API Error: ${data.error?.message || 'Request rejected.'}` });

    const candidate = data?.candidates?.[0];
    const originalModelParts = candidate?.content?.parts;
    if (!originalModelParts) return res.status(200).json({ reply: 'Execution failed: No content returned.' });

    const functionCallPart = originalModelParts.find(p => p.functionCall);
    
    if (functionCallPart && functionCallPart.functionCall.name === "generate_image") {
        let imageUrl = null;
        let activeEngine = 'Replicate (Flux)';
        let errorLog = '';

        if (replicateToken) {
            try {
                let repRes = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions', {
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${replicateToken}`, 'Content-Type': 'application/json', 'Prefer': 'wait' },
                  body: JSON.stringify({ input: { prompt: functionCallPart.functionCall.args.prompt } })
                });
                let repData = await repRes.json();
                
                if (repRes.ok && repData.output) {
                    imageUrl = Array.isArray(repData.output) ? repData.output[0] : repData.output;
                } else {
                    errorLog += `[Replicate Error: ${repData.detail || repData.error || 'Server timeout'}] `;
                }
            } catch (e) {
                errorLog += `[Replicate Catch: ${e.message}] `;
            }
        }

        if (!imageUrl && openaiKey) {
            activeEngine = 'OpenAI (DALL-E 3) Failover';
            try {
                let oaiRes = await fetch('https://api.openai.com/v1/images/generations', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: "dall-e-3", prompt: functionCallPart.functionCall.args.prompt, n: 1, size: "1024x1024" })
                });
                let oaiData = await oaiRes.json();
                
                if (oaiRes.ok && oaiData.data && oaiData.data[0].url) {
                    imageUrl = oaiData.data[0].url;
                } else {
                    errorLog += `[OpenAI Error: ${oaiData.error?.message || 'Unknown'}] `;
                }
            } catch (e) {
                errorLog += `[OpenAI Catch: ${e.message}] `;
            }
        }

        if (imageUrl) {
            return res.status(200).json({ reply: `Visual asset generated successfully via **${activeEngine}**.\n\n![Generated Media](${imageUrl})` });
        } else {
            return res.status(200).json({ reply: `**Total Media Engine Failure:** Both Replicate and OpenAI endpoints rejected the request.\n\nDiagnostics: ${errorLog}` });
        }
    }

    if (functionCallPart && functionCallPart.functionCall.name === "generate_video") {
        if (!replicateToken) return res.status(200).json({ reply: "System Error: REPLICATE_KEY is missing." });
        try {
            let repRes = await fetch('https://api.replicate.com/v1/models/minimax/video-01/predictions', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${replicateToken}`, 'Content-Type': 'application/json', 'Prefer': 'wait' },
              body: JSON.stringify({ input: { prompt: functionCallPart.functionCall.args.prompt } })
            });
            let repData = await repRes.json();
            
            if (!repRes.ok) {
                return res.status(200).json({ reply: `**Replicate Server Error (${repRes.status}):** The video model endpoint failed. Detail: ${repData.detail || repData.error || 'Server timeout.'}` });
            }

            if (repData.output) {
              let mediaUrl = Array.isArray(repData.output) ? repData.output[0] : repData.output;
              return res.status(200).json({ reply: `Video asset generated successfully.\n\n<video controls autoplay loop style="width:100%; border-radius:4px; border:1px solid #1E293B;"><source src="${mediaUrl}" type="video/mp4">Your browser does not support the video tag.</video>` });
            }
            return res.status(200).json({ reply: `Video generation failed. Status: ${repData.status || repData.error}.` });
        } catch (repErr) {
            return res.status(200).json({ reply: `Replicate API execution failed: ${repErr.message}` });
        }
    }

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
