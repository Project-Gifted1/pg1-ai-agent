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
    const actionType = body?.action || ''; 
    const targetFile = body?.file_path || 'api/chat.js';
    const pendingCode = body?.file_content || '';
    
    console.log(`[PG1-AGENT] Incoming Request. Action: ${actionType || 'CHAT'} | Prompt: ${promptText.substring(0, 50)}...`);

    if (promptText === 'AUTH_VERIFY') {
      console.log(`[PG1-AGENT] Auth verification ping received. Returning early.`);
      const inputUser = (body?.user || '').trim();
      const inputPass = (body?.pass || '').trim();
      return res.status(200).json({ authenticated: inputUser.length > 0 && inputPass.length > 0 });
    }

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

    const geminiKey = getDynamicKey(['GEMINI', 'GOOGLE', 'AI'], ['KEY', 'API']) || process.env.GEMINI_API_KEY1 || process.env.GEMINI_API_KEY || '';
    const supabaseUrl = getDynamicKey(['SUPABASE'], ['URL']) || process.env.SUPABASE_URL || '';
    const supabaseKey = getDynamicKey(['SUPABASE'], ['SERVICE', 'ROLE', 'KEY', 'API', 'ANON']) || '';
    const githubToken = getDynamicKey(['GITHUB', 'GH_', 'GIT'], ['TOKEN', 'PAT', 'KEY']) || process.env.GITHUB_TOKEN || '';
    const githubRepo = getDynamicKey(['GITHUB', 'REPO'], ['SLUG', 'NAME', 'REPO']) || process.env.GITHUB_REPO || '';
    const cartesiaKey = getDynamicKey(['CARTESIA'], ['KEY', 'API', 'TOKEN']) || process.env.CARTESIA_API_KEY || '';

    console.log(`[PG1-AGENT] Key Resolution - Gemini: ${!!geminiKey} | Supabase: ${!!supabaseUrl} | GitHub: ${!!githubToken} | Cartesia: ${!!cartesiaKey}`);

    let supabaseStatus = 'DISCONNECTED';
    let lastTableFetch = 'NO_ATTEMPT';

    if (actionType === 'SPEAK') {
      if (cartesiaKey) {
        try {
          const cleanText = promptText.replace(/[*_#]/g, '').substring(0, 750);
          const ttsRes = await fetch('https://api.cartesia.ai/tts/bytes', {
            method: 'POST',
            headers: { 'Cartesia-Version': '2024-06-10', 'X-API-Key': cartesiaKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model_id: 'sonic-3.6', transcript: cleanText, voice: { mode: 'id', id: 'a0e99841-438c-4a64-b679-ae501e7d6091' }, output_format: { container: 'mp3', encoding: 'mp3', sample_rate: 44100 } })
          });
          if (ttsRes.ok) {
            const arrayBuffer = await ttsRes.arrayBuffer();
            return res.status(200).json({ audio: Buffer.from(arrayBuffer).toString('base64'), audioStatus: 'SUCCESS' });
          }
        } catch (e) {
           return res.status(500).json({ error: e.message });
        }
      }
      return res.status(400).json({ error: 'Audio unavailable' });
    }

    if (!geminiKey) {
      return res.status(200).json({ reply: 'Config Error: Sovereign API Key could not be resolved from environment variables.' });
    }

    let formattedArchive = 'No prior matrix context.';
    let historicalErrors = '';
    let targetedHistoricalData = '';

    if (supabaseUrl && supabaseKey) {
      const headers = { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` };
      try {
        const testPing = await fetch(`${supabaseUrl}/rest/v1/messages?select=id&limit=1`, { headers });
        supabaseStatus = testPing.ok ? 'CONNECTED' : `ERROR_${testPing.status}`;
        lastTableFetch = testPing.ok ? 'SUCCESS' : await testPing.text();
      } catch (err) {
        supabaseStatus = 'EXCEPTION';
        lastTableFetch = err.message;
      }

      try {
        const msgRes = await fetch(`${supabaseUrl}/rest/v1/messages?select=role,content&order=created_at.desc&limit=15`, { headers });
        if (msgRes.ok) {
          const recent = await msgRes.json();
          if (Array.isArray(recent) && recent.length > 0) {
            formattedArchive = recent.reverse().map(m => `${m.role === 'model' ? 'AGENT' : 'OPERATOR'}: ${m.content}`).join('\n');
          }
        }
      } catch (e) {}
    }

    if (actionType === 'ACCEPT_AUTHORIZATION') {
      if (!githubToken || !githubRepo || !pendingCode) {
        return res.status(200).json({ reply: '[AGENT] Commit Interruption: Missing GitHub Token, Repository, or code payload in environment variables.' });
      }

      try {
        const ghApiHeaders = {
          'Authorization': `Bearer ${githubToken}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'Sovereign-Agent'
        };
        const fileCheckRes = await fetch(`https://api.github.com/repos/${githubRepo}/contents/${targetFile}`, { headers: ghApiHeaders });
        let fileSha = '';
        if (fileCheckRes.ok) {
          const fileData = await fileCheckRes.json();
          fileSha = fileData.sha;
        }

        const commitRes = await fetch(`https://api.github.com/repos/${githubRepo}/contents/${targetFile}`, {
          method: 'PUT',
          headers: { ...ghApiHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: `[AGENT] Permanent state synchronization for ${targetFile}`,
            content: Buffer.from(pendingCode).toString('base64'),
            sha: fileSha || undefined
          })
        });

        if (commitRes.ok) {
          return res.status(200).json({ reply: `[AGENT] Permanent Commit Confirmed: Successfully pushed patch to ${targetFile} via GitHub API.` });
        } else {
          const errJson = await commitRes.json();
          return res.status(200).json({ reply: `[AGENT] Commit Rejected: ${errJson.message || commitRes.status}` });
        }
      } catch (commitErr) {
        return res.status(200).json({ reply: `[AGENT] Commit Execution Error: ${commitErr.message}` });
      }
    }

    const systemInstruction = `You are PG1-AGENT, an autonomous sovereign intelligence operating on Vercel infrastructure.\n[LIVE SYSTEM TELEMETRY]: Supabase Status: ${supabaseStatus} | Last Table Fetch: ${lastTableFetch}\n[PRIOR RECENT CONTEXT]:\n${formattedArchive}`;

    const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: systemInstruction + '\n\nOperator Directive: ' + promptText }] }]
      })
    });

    const data = await geminiRes.json();
    let replyText = data?.candidates?.[0]?.content?.parts?.[0]?.text || 'Execution failed.';

    if (supabaseUrl && supabaseKey) {
      await fetch(`${supabaseUrl}/rest/v1/messages`, {
        method: 'POST',
        headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([{ role: 'user', content: promptText }, { role: 'model', content: replyText }])
      });
    }

    return res.status(200).json({ 
      reply: replyText, 
      audioStatus: 'SKIPPED',
      telemetry: { supabaseStatus, lastFetchStatus: lastTableFetch }
    });

  } catch (err) {
    return res.status(200).json({ reply: `Runtime Exception: ${err.message}` });
  }
}
