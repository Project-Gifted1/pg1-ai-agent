module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    let promptText = req.body?.prompt || 'System check.';
    
    // Handle Authentication Check from Frontend Gate matching Vercel Env Variables
    if (promptText === 'AUTH_VERIFY') {
      const inputUser = (req.body?.user || '').trim();
      const inputPass = (req.body?.pass || '').trim();
      const adminUser = (process.env.USER_API_KEY || '').trim();
      const adminPass = (process.env.USER_API_PASS || '').trim();

      if (inputUser === adminUser && inputPass === adminPass) {
        return res.status(200).json({ authenticated: true });
      } else {
        return res.status(200).json({ authenticated: false });
      }
    }

    const filePayload = req.body?.file; 
    
    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASEAPI_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
    const ghToken = (process.env.GITHUB_TOKEN || '').trim();
    const cfToken = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
    const gumroadId = (process.env.GUMROAD_PRODUCT_ID || process.env.PRODUCT_ID || '').trim();

    const geminiKeys = [
      (process.env.GEMINI_API_KEY1 || '').trim(),
      (process.env.GEMINI_API_KEY2 || '').trim(),
      (process.env.GEMINI_API_KEY || '').trim()
    ].filter(Boolean);

    if (geminiKeys.length === 0) {
      return res.status(200).json({ reply: 'System Error: Primary GEMINI core API keys offline.' });
    }

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
      } catch (dbErr) {}
    }

    const userParts = [];
    if (promptText) userParts.push({ text: promptText });
    if (filePayload) userParts.push(filePayload); 
    chatContents.push({ role: "user", parts: userParts });

    const pg1SystemInstruction = `You are PG1-AGENT, the core sovereign intelligence of Project-Gifted1.`;

    const requestBody = {
      systemInstruction: { parts: [{ text: pg1SystemInstruction }] },
      contents: chatContents
    };

    const targetModels = [
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-1.5-flash'
    ];

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
        } catch (e) {}
      }
      if (success) break;
    }

    if (!success || !response?.ok) {
      return res.status(200).json({ reply: `API Error: ${data?.error?.message || 'All primary models and fallbacks exhausted.'}` });
    }

    const textPart = data?.candidates?.[0]?.content?.parts?.find(p => p.text);
    
    if (textPart) {
      return res.status(200).json({ reply: textPart.text });
    }

    return res.status(200).json({ reply: 'Execution completed without text output.' });
  } catch (err) {
    return res.status(200).json({ reply: `Fatal Runtime Error: ${err.message}` });
  }
};
