export default async function handler(req, res) {
  // CORS configuration
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { prompt, messages } = req.body || {};
    const userMessage = prompt || (messages && messages[messages.length - 1]?.content) || '';

    if (!userMessage) {
      return res.status(400).json({ error: 'Missing prompt or message payload' });
    }

    // Complexity and length heuristic
    const complexKeywords = ["code", "refactor", "analyze", "debug", "architecture", "system", "vulnerability", "sql", "deploy"];
    const isComplex = complexKeywords.some((keyword) => userMessage.toLowerCase().includes(keyword));
    const isLong = userMessage.length > 500;

    const sysPrompt = "You are the PG1 Sovereign AI Agent. Provide precise, direct, and actionable solutions.";

    let apiUrl = '';
    let apiKey = '';
    let headers = { 'Content-Type': 'application/json' };
    let payload = {};

    if (isComplex || isLong) {
      // Gemini Route
      apiKey = (process.env.GEMINI_API_KEY1 || process.env.GEMINI_API_KEY || '').trim();

      if (!apiKey) {
        throw new Error('GEMINI_API_KEY environment variable is missing.');
      }

      apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
      payload = {
        systemInstruction: { parts: [{ text: sysPrompt }] },
        contents: [{ role: "user", parts: [{ text: userMessage }] }]
      };

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini API error (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      const outputText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return res.status(200).json({ reply: outputText, provider: 'gemini', model: 'gemini-1.5-flash' });

  
  } catch (error) {
    console.error('Routing execution error:', error);
    return res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
}
