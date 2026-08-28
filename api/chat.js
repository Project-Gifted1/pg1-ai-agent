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

    // Priority list based directly on your authorized model list
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
          contents: [{ parts: [{ text: promptText }] }]
        })
      });

      const data = await response.json();

      if (response.ok && data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        return res.status(200).json({ 
          reply: data.candidates[0].content.parts[0].text, 
          provider: `gemini (${model})` 
        });
      } else {
        lastError = data.error?.message || `Failed on ${model}`;
      }
    }

    return res.status(200).json({ 
      reply: `Routing failed across all verified models. Last Error: ${lastError}`, 
      provider: 'system' 
    });

  } catch (err) {
    return res.status(200).json({ reply: `Runtime Error: ${err.message}`, provider: 'system' });
  }
};
