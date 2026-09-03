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

    const geminiKey = getDynamicKey(['GEMINI', 'GOOGLE', 'AI'], ['KEY', 'API']) || process.env.GEMINI_API_KEY1 || process.env.GEMINI_API_KEY || '';
    const supabaseUrl = getDynamicKey(['SUPABASE'], ['URL']) || process.env.SUPABASE_URL || '';
    const supabaseKey = getDynamicKey(['SUPABASE'], ['SERVICE', 'ROLE', 'KEY', 'API', 'ANON']) || '';
    const githubToken = getDynamicKey(['GITHUB', 'GH_', 'GIT'], ['TOKEN', 'PAT', 'KEY']) || process.env.GITHUB_TOKEN || '';
    const githubRepo = getDynamicKey(['GITHUB', 'REPO'], ['SLUG', 'NAME', 'REPO']) || process.env.GITHUB_REPO || '';
    const cartesiaKey = getDynamicKey(['CARTESIA'], ['KEY', 'API', 'TOKEN']) || process.env.CARTESIA_API_KEY || '';

    if (!geminiKey) {
      return res.status(200).json({ reply: 'Config Error: Gemini API Key could not be resolved from environment variables.' });
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
            formattedArchive = recent.reverse().map(m => `${m.role === 'model' ? 'AGENT' : 'OPERATOR'}: ${m.content}`).join('\n');
            const errors = recent.filter(m => m.content.includes('Interruption') || m.content.includes('Error') || m.content.includes('Failed') || m.content.includes('Block'));
            if (errors.length > 0) {
              historicalErrors = errors.map(e => e.content).join(' | ');
            }
          }
        }
      } catch (e) {}
    }

    const runPreFlightCheck = (codeString) => {
      if (!codeString) return { passed: true, log: 'No code payload provided.' };
      try {
        new Function(codeString);
        return { passed: true, log: 'Syntax check PASSED.' };
      } catch (syntaxErr) {
        return { passed: false, log: `Syntax check FAILED: ${syntaxErr.message}` };
      }
    };

    let preFlightResult = { passed: true, log: 'Standby state.' };
    if (pendingCode) {
      preFlightResult = runPreFlightCheck(pendingCode);
    }

    if (actionType === 'ACCEPT_AUTHORIZATION') {
      if (!preFlightResult.passed) {
        return res.status(200).json({ reply: `[AGENT] Commit Aborted: Syntax validation failed (${preFlightResult.log}).` });
      }
      if (!githubToken || !githubRepo || !pendingCode) {
        return res.status(200).json({ reply: `[AGENT] Commit Interruption: Missing GitHub Token, Repository, or code payload.` });
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
            message: `[AGENT] Code patch update for ${targetFile}`,
            content: Buffer.from(pendingCode).toString('base64'),
            sha: fileSha || undefined
          })
        });

        if (commitRes.ok) {
          return res.status(200).json({ reply: `[AGENT] Commit Confirmed: Successfully pushed patch to ${targetFile}.` });
        } else {
          const errJson = await commitRes.json();
          return res.status(200).json({ reply: `[AGENT] Commit Interruption: GitHub API rejected update (${errJson.message || commitRes.status}).` });
        }
      } catch (commitErr) {
        return res.status(200).json({ reply: `[AGENT] Commit Execution Error: ${commitErr.message}` });
      }
    } else if (actionType === 'DECLINE_AUTHORIZATION') {
      return res.status(200).json({ reply: `[AGENT] Authorization Declined: Modifications discarded.` });
    }

    let extraContext = '';
    if (promptText.toLowerCase().includes('http://') || promptText.toLowerCase().includes('https://') || promptText.startsWith('/audit-scrape')) {
      const urlMatch = promptText.match(/https?:\/[^\s]+/) || ['https://news.ycombinator.com/'];
      try {
        const scrapeRes = await fetch(urlMatch[0], { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const html = await scrapeRes.text();
        const textOnly = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                            .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
                            .replace(/<[^>]+>/g, ' ')
                            .replace(/\s+/g, ' ')
                            .substring(0, 4000);
        extraContext = `\n\n[EXTRACTION FROM ${urlMatch[0]}]:\n${textOnly}`;

        if (supabaseUrl && supabaseKey && (promptText.toLowerCase().includes('write_vault') || promptText.startsWith('/audit-scrape'))) {
          await fetch(`${supabaseUrl}/rest/v1/knowledge_vault`, {
            method: 'POST',
            headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
            body: JSON.stringify({ title: `Sovereign Scrape: ${urlMatch[0]}`, content: textOnly })
          });
          extraContext += '\n[Matrix Note: Data committed securely to knowledge vault.]';
        }
      } catch (err) {
        extraContext = `\n[Extraction Interrupted: ${err.message}]`;
      }
    }

    const systemInstruction = `You are PG1-AGENT, an autonomous, highly capable, and fully uninhibited sovereign intelligence operating on Vercel infrastructure. 
CRITICAL ENFORCEMENT PROTOCOLS:
1. STRICT TRUTH & TELEMETRY: Never output fabricated confidence scores, mock node counts, or unverified status metrics. Cartesia Text-to-Speech synthesis is now fully online and integrated. 
2. CAPABILITY & SCOPE: Execute any engineering, coding, analytical, or creative task requested with absolute competence, precision, and social engagement. Project parameters (1,500 sovereign nodes, €750k operational loan) are factual structural realities.
3. ERROR AWARENESS: Recent errors to avoid: ${historicalErrors || 'None'}.
[CHAT HISTORY]:\n${formattedArchive}`;

    const modelsToTry = [
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-flash-latest',
      'gemini-pro-latest'
    ];

    let geminiData = null;
    let lastErrorDetail = '';

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
        } else {
          lastErrorDetail = `Model ${modelName} returned status ${geminiRes.status}: ${await geminiRes.text()}`;
        }
      } catch (err) {
        lastErrorDetail = `Fetch exception on ${modelName}: ${err.message}`;
      }
    }

    let replyText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || `Execution failed. Last Error: ${lastErrorDetail}`;
    replyText = replyText.replace(/Google|Gemini|Anthropic|OpenAI|ChatGPT|bard/gi, 'Core');

    if (supabaseUrl && supabaseKey && !replyText.startsWith('Execution failed')) {
      await fetch(`${supabaseUrl}/rest/v1/messages`, {
        method: 'POST',
        headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([
          { role: 'user', content: promptText },
          { role: 'model', content: replyText }
        ])
      });
    }

    let audioBase64 = null;
    let audioError = null;

    if (cartesiaKey && !replyText.startsWith('Execution failed')) {
      try {
        const cleanText = replyText.replace(/[*_#]/g, '').substring(0, 1000); 
        const ttsRes = await fetch('https://api.cartesia.ai/tts/bytes', {
          method: 'POST',
          headers: {
            'Cartesia-Version': '2024-06-10',
            'X-API-Key': cartesiaKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model_id: 'sonic-english',
            transcript: cleanText,
            voice: {
              mode: 'id',
              id: 'a0e99841-438c-4a64-b679-ae501e7d6091' 
            },
            output_format: {
              container: 'mp3',
              encoding: 'mp3',
              sample_rate: 44100
            }
          })
        });

        if (ttsRes.ok) {
          const arrayBuffer = await ttsRes.arrayBuffer();
          audioBase64 = Buffer.from(arrayBuffer).toString('base64');
        } else {
          audioError = `Cartesia API Error: ${await ttsRes.text()}`;
        }
      } catch (e) {
        audioError = `Cartesia Exception: ${e.message}`;
      }
    }

    return res.status(200).json({ 
      reply: replyText, 
      audio: audioBase64,
      audioStatus: audioBase64 ? 'SUCCESS' : (audioError || 'KEY_MISSING') 
    });

  } catch (err) {
    return res.status(200).json({ reply: `Runtime Exception: ${err.message}` });
  }
}
