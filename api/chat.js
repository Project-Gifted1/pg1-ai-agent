const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    let promptText = req.body?.prompt || 'Analyze the attached file.';
    const filePayload = req.body?.file; 
    
    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASEAPI_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

    const geminiKeys = [
      (process.env.GEMINI_API_KEY1 || '').trim(),
      (process.env.GEMINI_API_KEY2 || '').trim(),
      (process.env.GEMINI_API_KEY || '').trim()
    ].filter(Boolean);
    
    if (geminiKeys.length === 0) return res.status(200).json({ reply: 'System Error: No GEMINI API keys found.' });

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

    const pg1SystemInstruction = `You are PG1-AGENT (or PG1 for short), the core sovereign intelligence of Project-Gifted1.`;

    const requestBody = {
      systemInstruction: { parts: [{ text: pg1SystemInstruction }] },
      contents: historyContents
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

    if (!response.ok) return res.status(200).json({ reply: `API Error: ${data.error?.message || 'Request rejected.'}` });

    const candidate = data?.candidates?.[0];
    const originalModelParts = candidate?.content?.parts;
    if (!originalModelParts) return res.status(200).json({ reply: 'Execution failed: No content returned.' });

    const textPart = originalModelParts.find(p => p.text);
    
    if (supabase && textPart) {
        await supabase.from('messages').insert([
            { role: 'user', content: promptText },
            { role: 'model', content: textPart.text }
        ]);
    }

    if (textPart) return res.status(200).json({ reply: textPart.text });

    return res.status(200).json({ reply: 'Execution completed.' });
  } catch (err) {
    return res.status(200).json({ reply: `Runtime Error: ${err.message}` });
  }
};
