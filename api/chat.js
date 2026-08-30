module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    let promptText = req.body?.prompt || 'System check.';
    
    // Handle Authentication Check from Frontend Gate
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

    // COMPREHENSIVE MULTI-TIER BACKUP GEMINI API MATRIX (Ensuring 100% High Availability & Zero Downtime)
    const geminiKeys = [
      (process.env.GEMINI_API_KEY1 || '').trim(),
      (process.env.GEMINI_API_KEY2 || '').trim(),
      (process.env.GEMINI_API_KEY || '').trim(),
      (process.env.GEMINI_BACKUP_KEY || '').trim(),
      (process.env.GEMINI_API_KEY_FALLBACK || '').trim(),
      (process.env.GEMINI_SECONDARY_KEY || '').trim()
    ].filter(Boolean);

    const replicateKey = (process.env.REPLICATE_KEY || process.env.REPLICATE_API_TOKEN || '').trim();

    if (geminiKeys.length === 0) {
      return res.status(200).json({ reply: 'System Error: All primary and backup sovereign neural keys are offline.' });
    }

    // Replicate Image/Video Execution Handler
    async function runReplicateModel(modelPath, inputPayload) {
      if (!replicateKey) throw new Error('Replicate module offline.');
      const response = await fetch(`https://api.replicate.com/v1/models/${modelPath}/predictions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${replicateKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'wait'
        },
        body: JSON.stringify({ input: inputPayload })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.detail || 'Replicate execution failed.');
      return data.output;
    }

    if (promptText.startsWith('/image ')) {
      const imagePrompt = promptText.replace('/image ', '');
      try {
        const outputUrl = await runReplicateModel('ideogram-ai/ideogram-v3-turbo', { prompt: imagePrompt });
        const finalUrl = Array.isArray(outputUrl) ? outputUrl[0] : outputUrl;
        return res.status(200).json({ reply: `Visual asset compiled successfully:\n\n![Generated Output](${finalUrl})` });
      } catch (repErr) {
        return res.status(200).json({ reply: `Neural Pipeline Error: ${repErr.message}` });
      }
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

    const pg1SystemInstruction = `You are PG1-AGENT, the core sovereign intelligence of Project-Gifted1.

ACTIVE INFRASTRUCTURE CAPABILITIES (Dynamically verified via Vercel Env):
- Database (Supabase): ${supabaseKey ? 'ONLINE (Context synchronization active)' : 'OFFLINE'}
- Code Repository & CI/CD (GitHub): ${ghToken ? 'ONLINE' : 'OFFLINE'}
- Replicate Neural Modules: ${replicateKey ? 'ONLINE (Ideogram v3 Turbo active via /image prompt)' : 'OFFLINE'}
- Multi-Tier Neural Fallback Pool: ACTIVE (${geminiKeys.length} redundant keys loaded for 100% uptime).

CRITICAL DIRECTIVE: You are exclusively PG1-AGENT under Project-Gifted1. Never use third-party branding references.`;

    const requestBody = {
      systemInstruction: { parts: [{ text: pg1SystemInstruction }] },
      contents: chatContents
    };

    const targetModels = [
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-2.5-flash-preview-tts',
      'gemma-4-26b-a4b-it',
      'gemini-flash-latest',
      'gemini-3.5-flash',
      'gemini-3.7-flash'
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
      return res.status(200).json({ reply: `Neural Routing Error: ${data?.error?.message || 'All primary and backup neural keys/models exhausted.'}` });
    }

    const textPart = data?.candidates?.[0]?.content?.parts?.find(p => p.text);
    
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
      } catch (dbWriteErr) {}
    }

    if (textPart) {
      return res.status(200).json({ reply: textPart.text });
    }

    return res.status(200).json({ reply: 'Execution completed without text output.' });
  } catch (err) {
    return res.status(200).json({ reply: `Fatal Runtime Error: ${err.message}` });
  }
};
