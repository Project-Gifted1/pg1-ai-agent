module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  try {
    const { message, userMessage } = req.body || {};
    const promptText = userMessage || message || '';
    const apiKey = (process.env.GEMINI_API_KEY1 || '').trim();
    
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY1 missing.' });

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }] })
    });

    const data = await response.json();
    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated.';
    return res.status(200).json({ reply, provider: 'gemini' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
