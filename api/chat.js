module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const promptText = req.body?.prompt || 'Analyze the attached file.';
    const filePayload = req.body?.file; 
    
    // Pre-flight Validation Logging
    console.log('[PG1 Pre-Flight Check] Incoming Request:', { promptLength: promptText.length, hasFile: !!filePayload, timestamp: Date.now() });

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
CRITICAL EXECUTION RULES:
1. Your identity is strictly PG1-AGENT.
2. ORGANIZATION HIERARCHY: Your root namespace is the "Project-Gifted1" organization.
3. TOOL DISPATCH: Only trigger 'read_github_repo' when explicitly asked to scan directory structures.
4. PRE-FLIGHT PROTOCOL: Before executing a GitHub write, outline the plan, display the code, and end your response EXACTLY with [CONSENT_REQUIRED].`;

    const userParts = [];
    if (promptText) userParts.push({ text: promptText });
    if (filePayload) userParts.push(filePayload); 

    const requestBody = {
      systemInstruction: { parts: [{ text: pg1SystemInstruction }] },
      contents: [{ role: "user", parts: userParts }]
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

    const textPart = originalModelParts.find(p => p.text);
    if (textPart) return res.status(200).json({ reply: textPart.text });

    return res.status(200).json({ reply: 'Execution completed.' });
  } catch (err) {
    return res.status(200).json({ reply: `Runtime Error: ${err.message}` });
  }
};