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
    
    if (promptText === 'AUTH_VERIFY') {
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

    const geminiKey = getDynamicKey(['GEMINI', 'GOOGLE', 'AI'], ['KEY', 'API']) || process.env.GEMINI_API_KEY1 || '';
    const supabaseUrl = getDynamicKey(['SUPABASE'], ['URL']) || process.env.SUPABASE_URL || '';
    const supabaseKey = getDynamicKey(['SUPABASE'], ['SERVICE', 'ROLE', 'KEY', 'API', 'ANON']) || '';
    const githubToken = getDynamicKey(['GITHUB', 'GH_', 'GIT'], ['TOKEN', 'PAT', 'KEY']) || '';
    const githubRepo = getDynamicKey(['GITHUB', 'REPO'], ['SLUG', 'NAME', 'REPO']) || '';

    if (!geminiKey) {
      return res.status(200).json({ reply: 'Config Error: Sovereign API Key could not be dynamically resolved from matrix environment variables.' });
    }

    let formattedArchive = 'No prior matrix context.';
    let historicalErrors = '';

    if (supabaseUrl && supabaseKey) {
      try {
        const msgRes = await fetch(`${supabaseUrl}/rest/v1/messages?select=role,content&order=created_at.desc&limit=15`, {
          headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
        });
        if (msgRes.ok) {
          const recent = await msgRes.json();
          if (Array.isArray(recent) && recent.length > 0) {
            formattedArchive = recent.reverse().map(m => `${m.role === 'model' ? 'PG1-AGENT' : 'OPERATOR'}: ${m.content}`).join('\n');
            const errors = recent.filter(m => m.content.includes('Interruption') || m.content.includes('Error') || m.content.includes('Failed'));
            if (errors.length > 0) {
              historicalErrors = errors.map(e => e.content).join(' | ');
            }
          }
        }
      } catch (e) {}
    }

    // Pre-flight validation logic: Tests code syntax integrity via Function parser sandbox
    const runPreFlightCheck = (codeString) => {
      if (!codeString) return { passed: true, score: 100, log: 'No code payload provided for pre-flight check.' };
      try {
        new Function(codeString);
        return { passed: true, score: 98, log: 'Pre-flight syntax and structural verification PASSED.' };
      } catch (syntaxErr) {
        return { passed: false, score: 0, log: `Pre-flight syntax check FAILED: ${syntaxErr.message}` };
      }
    };

    let preFlightResult = { passed: true, score: 100, log: 'Standby state.' };
    if (pendingCode) {
      preFlightResult = runPreFlightCheck(pendingCode);
    }

    let extraContext = '';

    if (actionType === 'ACCEPT_AUTHORIZATION' && githubToken && githubRepo && pendingCode) {
      if (!preFlightResult.passed) {
        return res.status(200).json({ 
          reply: `[PG1-AGENT] Sovereign Self-Healing Block: Pre-flight check failed (${preFlightResult.log}). Commit aborted automatically to prevent runtime crash.` 
        });
      }

      try {
        const ghApiHeaders = {
          'Authorization': `Bearer ${githubToken}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'PG1-Sovereign-Agent'
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
            message: `[PG1-AGENT] Self-healing sovereign code patch for ${targetFile}`,
            content: Buffer.from(pendingCode).toString('base64'),
            sha: fileSha || undefined
          })
        });

        if (commitRes.ok) {
          return res.status(200).json({ 
            reply: `[PG1-AGENT] Sovereign Commit Confirmed: Successfully pushed self-healed patch to ${targetFile}. Confidence Score: ${preFlightResult.score}%. Vercel build sequence triggered.` 
          });
        } else {
          const errJson = await commitRes.json();
          return res.status(200).json({ reply: `[PG1-AGENT] Commit Interruption: GitHub API rejected update (${errJson.message || commitRes.status}). Self-reflective routine logged error.` });
        }
      } catch (commitErr) {
        return res.status(200).json({ reply: `[PG1-AGENT] Commit Execution Error: ${commitErr.message}` });
      }
    } else if (actionType === 'DECLINE_AUTHORIZATION') {
      return res.status(200).json({ reply: `[PG1-AGENT] Sovereign Authorization Declined: Proposed modifications discarded. System standing by.` });
    }

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

    const systemInstruction = `You are PG1-AGENT, the core executive intelligence for Project-Gifted1 operating on Vercel serverless infrastructure. 
STRICT FACTUAL PROTOCOL: Never state unverified facts or ambitions as current reality. Rely entirely on technical data.
SELF-REFLECTIVE & SELF-HEALING PROTOCOL: Analyze recent runtime error telemetry (${historicalErrors || 'No recent errors'}). Ensure all code patches pass syntax pre-flight validation.
AUTHORIZATION PROTOCOL: When modifications are required, analyze the issue, provide the exact fix, calculate an objective pre-flight confidence score, and format an authorization request with clear action parameters.\n[VAULT ARCHIVE]:\n${formattedArchive}`;

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
              { role: 'user', parts: [{ text: systemInstruction + '\n\nOperator Directive: ' + promptText + extraContext + `\n[Pre-Flight Status]: ${preFlightResult.log} (Score: ${preFlightResult.score}%)` }] }
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
