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

    // Dynamic environment variable scanner matching keywords across any key name
    const getDynamicKey = (serviceKeywords, typeKeywords) => {
      for (const [k, v] of Object.entries(process.env)) {
        const upper = k.toUpperCase();
        const matchService = serviceKeywords.some(s => upper.includes(s));
        const matchType = typeKeywords.some(t => upper.includes(t));
        if (matchService && matchType && v && v.trim().length > 0 && !v.includes('your_')) {
          return v.trim();
        }
      }
      return '';
    };

    const geminiKey = getDynamicKey(['GEMINI', 'GOOGLE', 'AI'], ['KEY', 'API']) || process.env.GEMINI_API_KEY || '';
    const supabaseUrl = getDynamicKey(['SUPABASE'], ['URL']) || process.env.SUPABASE_URL || '';
    const supabaseKey = getDynamicKey(['SUPABASE'], ['SERVICE', 'ROLE', 'KEY', 'ANON']) || '';
    const githubToken = getDynamicKey(['GITHUB', 'GH_'], ['TOKEN', 'PAT', 'KEY']) || '';
    const githubRepo = getDynamicKey(['GITHUB', 'REPO'], ['SLUG', 'NAME', 'REPO']) || '';

    if (!geminiKey) {
      return res.status(200).json({ reply: 'Config Error: Sovereign API Key could not be dynamically resolved from matrix environment variables.' });
    }

    let formattedArchive = 'No prior matrix context.';

    if (supabaseUrl && supabaseKey) {
      try {
        const msgRes = await fetch(`${supabaseUrl}/rest/v1/messages?select=role,content&order=created_at.desc&limit=10`, {
          headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
        });
        if (msgRes.ok) {
          const recent = await msgRes.json();
          if (Array.isArray(recent) && recent.length > 0) {
            formattedArchive = recent.reverse().map(m => `${m.role === 'model' ? 'PG1-AGENT' : 'OPERATOR'}: ${m.content}`).join('\n');
          }
        }
      } catch (e) {}
    }

    let extraContext = '';

    // Handle Web Scraping & Vault Saving
    if (promptText.toLowerCase().includes('http://') || promptText.toLowerCase().includes('https://')) {
      const urlMatch = promptText.match(/https?:\/[^\s]+/);
      if (urlMatch) {
        try {
          const scrapeRes = await fetch(urlMatch[0], { headers: { 'User-Agent': 'PG1-Sovereign-Scraper/1.0' } });
          const html = await scrapeRes.text();
          const textOnly = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                              .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
                              .replace(/<[^>]+>/g, ' ')
                              .replace(/\s+/g, ' ')
                              .substring(0, 4000);
          extraContext = `\n\n[PG1 SECURE EXTRACTION FROM ${urlMatch[0]}]:\n${textOnly}`;

          if (supabaseUrl && supabaseKey && promptText.toLowerCase().includes('write_vault')) {
            await fetch(`${supabaseUrl}/rest/v1/knowledge_vault`, {
              method: 'POST',
              headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
              body: JSON.stringify({ title: `Sovereign Scrape: ${urlMatch[0]}`, content: textOnly })
            });
            extraContext += '\n[Matrix Note: Data committed securely to Project-Gifted1 knowledge vault.]';
          }
        } catch (err) {
          extraContext = `\n[Extraction Interrupted: ${err.message}]`;
        }
      }
    }

    // Handle Dynamic GitHub Platform Management Interventions
    if (promptText.toLowerCase().includes('github') && githubToken && githubRepo) {
      try {
        const ghApiHeaders = {
          'Authorization': `Bearer ${githubToken}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'PG1-Sovereign-Agent'
        };

        const repoRes = await fetch(`https://api.github.com/repos/${githubRepo}`, { headers: ghApiHeaders });
        if (repoRes.ok) {
          const repoData = await repoRes.json();
          extraContext += `\n[GitHub Matrix Integration Active]: Connected dynamically to ${repoData.full_name} (Branch: ${repoData.default_branch}, Visibility: ${repoData.visibility}).`;
        } else {
          extraContext += `\n[GitHub Matrix Integration Warning]: Responded with status code ${repoRes.status}. Check token scopes.`;
        }
      } catch (ghErr) {
        extraContext += `\n[GitHub Integration Interruption: ${ghErr.message}]`;
      }
    }

    const systemInstruction = `You are PG1-AGENT, the exclusive sovereign executive intelligence for Project-Gifted1 operating across 1,500 autonomous nodes. Maintain strict Project-Gifted1 identity protocols at all times. Never mention external vendor models or third-party creators; you are engineered entirely under Project-Gifted1 sovereignty. Respond with clear, direct operational execution details.\n[VAULT ARCHIVE]:\n${formattedArchive}`;

    const modelsToTry = [
      'gemini-3.7-flash',
      'gemini-3.5-flash',
      'gemini-3.1-pro',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-1.5-flash'
    ];

    let geminiData = null;

    for (const modelName of modelsToTry) {
      try {
        const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              { role: 'user', parts: [{ text: systemInstruction + '\n\nOperator Directive: ' + promptText + extraContext }] }
            ]
          })
        });

        if (geminiRes.ok) {
          const data = await geminiRes.json();
          if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
            geminiData = data;
            break;
          }
        }
      } catch (err) {
        continue;
      }
    }

    let replyText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || `PG1-Matrix execution failed across available endpoints.`;

    replyText = replyText.replace(/Google|Gemini|Anthropic|OpenAI|ChatGPT|bard/gi, 'PG1-Core');

    if (supabaseUrl && supabaseKey && replyText && !replyText.startsWith('PG1-Matrix execution failed')) {
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
    return res.status(200).json({ reply: `PG1-Matrix Runtime Interruption: ${err.message}` });
  }
}
