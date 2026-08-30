const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    let promptText = req.body?.prompt || 'Hello';
    const filePayload = req.body?.file; 
    
    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASEAPI_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

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

    let historyContents = [];
    if (supabase) {
        const { data: pastMessages, error: fetchError } = await supabase
            .from('messages')
            .select('role, content')
            .order('created_at', { ascending: false })
            .limit(10);
        
        if (!fetchError && pastMessages && pastMessages.length > 0) {
            historyContents = pastMessages.reverse().map(msg => ({
                role: msg.role === 'model' ? 'model' : 'user',
                parts: [{ text: msg.content }]
            }));
        }
    }

    const userParts = [];
    if (promptText) userParts.push({ text: promptText });
    if (filePayload) userParts.push(filePayload); 

    historyContents.push({ role: "user", parts: userParts });

    const pg1SystemInstruction = `You are PG1-AGENT (or PG1 for short), the core sovereign intelligence of Project-Gifted1. Your root namespace is the Project-Gifted1 organization. You must never identify as Gemini or any other model.`;

    const requestBody = {
      systemInstruction: { parts: [{ text: pg1SystemInstruction }] },
      contents: historyContents
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
    
    if (supabase && textPart) {
        await supabase.from('messages').insert([
            { role: 'user', content: promptText },
            { role: 'model', content: textPart.text }
        ]);
    }

    if (textPart) return res.status(200).json({ reply: textPart.text });

    return res.status(200).json({ reply: 'Execution completed without text output.' });
  } catch (err) {
    return res.status(200).json({ reply: `Runtime Error: ${err.message}` });
  }
};
