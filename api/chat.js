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

    const requestBody = {
      contents: [{ role: "user", parts: [{ text: promptText }] }]
    };

    let response;
    let data;

    for (let i = 0; i < geminiKeys.length; i++) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=${geminiKeys[i]}`;
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });
      data = await response.json();
      if (response.ok) break;
      if (response.status !== 429 && response.status !== 403) break;
    }

    if (!response.ok) {
      return res.status(200).json({ reply: `API Error: ${data.error?.message || 'Request rejected.'}` });
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
