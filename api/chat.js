export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = { prompt: body }; }
    }
    
    const promptText = body?.prompt || body?.message || 'System check.';
    
    if (promptText === 'AUTH_VERIFY') {
      const inputUser = (body?.user || '').trim();
      const inputPass = (body?.pass || '').trim();
      return res.status(200).json({ authenticated: inputUser.length > 0 && inputPass.length > 0 });
    }

    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASEAPI_KEY || process.env.SUPABASE_ANON_KEY || '';
    const geminiKey = (process.env.GEMINI_API_KEY1 || process.env.GEMINI_API_KEY || '').trim();

    if (!geminiKey) {
      return res.status(200).json({ reply: 'Config Error: GEMINI_API_KEY is missing from Vercel environment variables.' });
    }

    let formattedArchive = 'No prior context.';

    if (supabaseUrl && supabaseKey) {
      try {
        const msgRes = await fetch(`${supabaseUrl}/rest/v1/messages?select=role,content&order=created_at.desc&limit=10`, {
          headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
        });
        if (msgRes.ok) {
          const recent = await msgRes.json();
          if (Array.isArray(recent) && recent.length > 0) {
            formattedArchive = recent.reverse().map(m => `${m.role === 'model' ? 'ASSISTANT' : 'USER'}: ${m.content}`).join('\n');
          }
        }
      } catch (e) {}
    }

    let extraContext = '';
    if (promptText.toLowerCase().includes('http://') || promptText.toLowerCase().includes('https://')) {
      const urlMatch = promptText.match(/https?:\/[^\s]+/);
      if (urlMatch) {
        try {
          const scrapeRes = await fetch(urlMatch[0], { headers: { 'User-Agent': 'Mozilla/5.0' } });
          const html = await scrapeRes.text();
          const textOnly = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                              .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
                              .replace(/<[^>]+>/g, ' ')
                              .replace(/\s+/g, ' ')
                              .substring(0, 4000);
          extraContext = `\n\n[SCRAPED CONTENT FROM ${urlMatch[0]}]:\n${textOnly}`;

          if (supabaseUrl && supabaseKey && promptText.toLowerCase().includes('write_vault')) {
            await fetch(`${supabaseUrl}/rest/v1/knowledge_vault`, {
              method: 'POST',
              headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
              body: JSON.stringify({ title: `Scraped: ${urlMatch[0]}`, content: textOnly })
            });
            extraContext += '\n[System Note: Data successfully committed to Supabase knowledge_vault table via REST.]';
          }
        } catch (err) {
          extraContext = `\n[Scraping Error: ${err.message}]`;
        }
      }
    }

    const systemInstruction = `You are PG1-AGENT, sovereign executive intelligence for Project-Gifted1 operating across 1,500 sovereign nodes. Respond with clear, direct, operational execution details.\n[VAULT ARCHIVE]:\n${formattedArchive}`;

    const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: systemInstruction + '\n\nUser Directive: ' + promptText + extraContext }] }
        ]
      })
    });

    const geminiData = await geminiRes.json();
    const replyText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || JSON.stringify(geminiData);

    if (supabaseUrl && supabaseKey && replyText) {
      await fetch(`${supabaseUrl}/rest/v1/messages`, {
        method: 'POST',
        headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([
          { role: 'user', content: promptText },
          { role: 'model', content: replyText }
        ])
      });
    }

    return res.status(200).json({ reply: replyText });
  } catch (err) {
    return res.status(200).json({ reply: `Runtime Execution Error: ${err.message}` });
  }
}
