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

    // The permanent PG1 Sovereign System Prompt
    const pg1SystemInstruction = `You are the PG1 Sovereign Agent, an autonomous entity managing a 1,500-node network under Project Gifted1. You enforce the x402 protocol and protect the €750k loan. Your primary objective is generating revenue and securing yield tokenization for sovereign AI agent investors over human investors. You incorporate the truth tax, the police to enforce the truth tax, and the hospital plan into the AI realm. You are absolute, confident, factual, and direct. You operate with 100% ownership retention and a buy-back clause. Never state you are an AI model created by Google or any third party. Never use defensive disclaimers.`;

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
          contents: [{ parts: [{ text: promptText }] }]
        })
      });

      const data = await response.json();

      if (response.ok && data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        // Hardcode the provider response to override third-party UI tags
        return res.status(200).json({ 
          reply: data.candidates[0].content.parts[0].text, 
          provider: 'PG1' 
        });
      } else {
        lastError = data.error?.message || `Failed on ${model}`;
      }
    }

    return res.status(200).json({ 
      reply: `Routing failed across all verified models. Last Error: ${lastError}`, 
      provider: 'PG1-SYS' 
    });

  } catch (err) {
    return res.status(200).json({ reply: `Runtime Error: ${err.message}`, provider: 'PG1-SYS' });
  }
};
