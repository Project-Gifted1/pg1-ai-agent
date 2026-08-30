module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    let promptText = req.body?.prompt || 'Hello';
    
    const geminiKeys = [
      (process.env.GEMINI_API_KEY1 || '').trim(),
      (process.env.GEMINI_API_KEY2 || '').trim(),
      (process.env.GEMINI_API_KEY || '').trim()
    ].filter(Boolean);
    
    if (geminiKeys.length === 0) {
      return res.status(200).json({ reply: 'System Error: No GEMINI API keys found in Vercel environment variables.' });
    }

    const targetModels = [
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-flash-latest',
      'gemini-pro-latest'
    ];

    const requestBody = {
      contents: [{ role: "user", parts: [{ text: promptText }] }]
    };

    let response = null;
    let data = null;
    let success = false;

    for (const key of geminiKeys) {
      for (const model of targetModels) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
        try {
          response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
          });
          data = await response.json();
          if (response.ok && data?.candidates?.[0]) {
            success = true;
            break;
          }
        } catch (e) {
          // Continue fallback sequence
        }
      }
      if (success) break;
    }

    if (!success || !response?.ok) {
      return res.status(200).json({ reply: `API Error: ${data?.error?.message || 'All fallback models exhausted.'}` });
    }

    const textPart = data?.candidates?.[0]?.content?.parts?.find(p => p.text);
    if (textPart) {
      return res.status(200).json({ reply: textPart.text });
    }

    return res.status(200).json({ reply: 'Execution completed without text output.' });
  } catch (err) {
    return res.status(200).json({ reply: `Runtime Error: ${err.message}` });
  }
};
