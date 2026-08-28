module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  try {
    const promptText = req.body?.userMessage || req.body?.message || '';
    const apiKey = (process.env.GEMINI_API_KEY1 || '').trim();
    
    if (!apiKey) return res.status(200).json({ reply: 'Vercel Error: GEMINI_API_KEY1 missing.' });

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }] })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(200).json({ reply: `Google API Error: ${data.error?.message || 'Invalid Request'}`, provider: 'gemini' });
    }

    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated.';
    return res.status(200).json({ reply, provider: 'gemini' });
  } catch (err) {
    return res.status(200).json({ reply: `Execution Error: ${err.message}`, provider: 'gemini' });
  }
};
