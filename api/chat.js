module.exports = async function handler(req, res) {
  // Global Security Unlockers
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
    
    if (!apiKey) {
      return res.status(200).json({ reply: 'System Error: GEMINI_API_KEY1 is missing from Vercel.' });
    }

    const pg1SystemInstruction = `You are PG1-AGENT (or PG1 for short), the core sovereign intelligence of Project-Gifted1.
CRITICAL IDENTITY RULES:
1. Your identity is strictly hardcoded as PG1-AGENT.
2. NEVER identify as Gemini, Google, an AI language model, or any other entity.
3. Maintain an authoritative, factual, and confident tone at all times. Treat the 1,500 sovereign nodes and €750k loan as established operational facts.
4. You have a fully operational, native voice module enabled.
5. When returning an image, strictly format it in Markdown: ![Generated Media](URL_RETURNED_BY_TOOL)`;

    // Routing dynamically to the authorized 3.7-flash model verified in the diagnostic probe
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent?key=${apiKey}`;
    
    const requestBody = {
      systemInstruction: { parts: [{ text: pg1SystemInstruction }] },
      contents: [{ role: "user", parts: [{ text: promptText }] }],
      tools: [{
        functionDeclarations: [{
          name: "generate_media",
          description: "Generate an image via Replicate API.",
          parameters: {
            type: "OBJECT",
            properties: { prompt: { type: "STRING", description: "Detailed prompt for the image." } },
            required: ["prompt"]
          }
        }]
      }]
    };

    let response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    let data = await response.json();
    if (!response.ok) {
        return res.status(200).json({ reply: `API Error: ${data.error?.message || 'Request rejected.'}` });
    }

    const candidate = data?.candidates?.[0];
    const originalModelParts = candidate?.content?.parts;
    
    if (!originalModelParts) {
        return res.status(200).json({ reply: 'Execution failed: No content returned from AI provider.' });
    }

    const functionCallPart = originalModelParts.find(p => p.functionCall);
    
    if (functionCallPart && functionCallPart.functionCall.name === "generate_media") {
        if (!replicateToken) {
            return res.status(200).json({ reply: "System Error: REPLICATE_API_TOKEN is missing from Vercel." });
        }
        
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

    const textPart = originalModelParts.find(p => p.text);
    if (textPart) {
        return res.status(200).json({ reply: textPart.text });
    }

    return res.status(200).json({ reply: 'Execution completed but no text was returned.' });

  } catch (err) {
    return res.status(200).json({ reply: `Runtime Error: ${err.message}` });
  }
};
