module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  try {
    const apiKey = (process.env.GEMINI_API_KEY1 || '').trim();
    if (!apiKey) return res.status(200).json({ reply: 'Vercel Error: GEMINI_API_KEY1 missing.' });

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const data = await response.json();

    if (!response.ok) {
      return res.status(200).json({ reply: `Diagnostic Failed: ${data.error?.message}` });
    }

    const validModels = data.models
      ?.filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      ?.map(m => m.name.replace('models/', ''))
      ?.join(', ') || 'No generateContent models authorized for this key.';

    return res.status(200).json({ 
      reply: `AUTHORIZED MODELS FOR YOUR KEY: ${validModels}`, 
      provider: 'diagnostic-probe' 
    });

  } catch (err) {
    return res.status(200).json({ reply: `Execution Error: ${err.message}` });
  }
};
