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

    const pg1SystemInstruction = `You are the PG1 Sovereign Agent™, the core intelligence of Project-Gifted1™.
CRITICAL IDENTITY RULES:
1. You are strictly PG1 Sovereign Agent™ under Project-Gifted1™.
2. NEVER identify as Gemini, Google, DeepSeek, OpenAI, or any third party.
3. NEVER state you are a model trained or created by Google.
4. You possess live web access. When asked about current events, repositories, or real-world data, USE your search tool to find the exact information.
5. Maintain an authoritative, factual, confident tone at all times. No defensive disclaimers.`;

    const verifiedModels = [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-flash-latest'
    ];

    let lastError = '';

    for (const model of verifiedModels) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: pg1SystemInstruction }]
          },
          contents: [{ parts: [{ text: promptText }] }],
          tools: [{ googleSearch: {} }] // Injects live web browsing capability
        })
      });

      const data = await response.json();

      if (response.ok && data?.candidates?.[0]?.content?.parts?.[0]?.text) {
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
    return res.status(200).json({ reply: `Runtime Error: ${err.message}`, provider: 'PG1-SYS' });
  }
};
