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

    // Dynamic model fallback array
    const modelsToTry = [
      'gemini-1.5-pro',
      'gemini-1.5-flash',
      'gemini-1.0-pro'
    ];

    let lastError = '';

    // Loop through models until one accepts the request
    for (const model of modelsToTry) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }] })
      });

      const data = await response.json();

      if (response.ok && data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        // Success: Return the text and specify which model worked
        return res.status(200).json({ 
          reply: data.candidates[0].content.parts[0].text, 
          provider: `gemini (${model})` 
        });
      } else {
        // Failure: Store the error and move to the next model
        lastError = data.error?.message || 'Endpoint rejected request.';
      }
    }

    // If the script reaches this point, every model in the array failed
    return res.status(200).json({ 
      reply: `All fallbacks failed. Last Google API Error: ${lastError}`, 
      provider: 'gemini-fallback-system' 
    });

  } catch (err) {
    return res.status(200).json({ reply: `Execution Error: ${err.message}`, provider: 'system' });
  }
};
