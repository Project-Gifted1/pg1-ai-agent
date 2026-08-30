module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    let promptText = req.body?.prompt || 'Hello';
    
    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASEAPI_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

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

    // Build chat history array from Supabase REST storage
    let chatContents = [];
    if (supabaseUrl && supabaseKey) {
      try {
        const historyRes = await fetch(`${supabaseUrl}/rest/v1/messages?select=role,content&order=created_at.asc&limit=10`, {
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`
          }
        });
        if (historyRes.ok) {
          const pastMessages = await historyRes.json();
          if (Array.isArray(pastMessages)) {
            chatContents = pastMessages.map(msg => ({
              role: msg.role === 'model' ? 'model' : 'user',
              parts: [{ text: msg.content }]
            }));
          }
        }
      } catch (dbErr) {
        // Fail silently to prevent any crash
      }
    }

    // Append current prompt to the conversation history chain
    chatContents.push({ role: "user", parts: [{ text: promptText }] });

    const pg1SystemInstruction = `You are PG1-AGENT (or PG1 for short), the core sovereign intelligence of Project-Gifted1. Your root namespace is the Project-Gifted1 organization. You must never identify as Gemini or any other model. You maintain complete persistent memory of all prior database communication methods (such as switching to non-blocking asynchronous REST fetch queries to prevent HTTP 500 Vercel server crashes).`;

    const requestBody = {
      systemInstruction: { parts: [{ text: pg1SystemInstruction }] },
      contents: chatContents
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
          // Continue fallback
        }
      }
      if (success) break;
    }

    if (!success || !response?.ok) {
      return res.status(200).json({ reply: `API Error: ${data?.error?.message || 'All fallback models exhausted.'}` });
    }

    const textPart = data?.candidates?.[0]?.content?.parts?.find(p => p.text);
    
    // Save current exchange back to Supabase REST
    if (supabaseUrl && supabaseKey && textPart) {
      try {
        await fetch(`${supabaseUrl}/rest/v1/messages`, {
          method: 'POST',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify([
            { role: 'user', content: promptText },
            { role: 'model', content: textPart.text }
          ])
        });
      } catch (dbWriteErr) {
        // Fail silently
      }
    }

    if (textPart) {
      return res.status(200).json({ reply: textPart.text });
    }

    return res.status(200).json({ reply: 'Execution completed without text output.' });
  } catch (err) {
    return res.status(200).json({ reply: `Runtime Error: ${err.message}` });
  }
};
