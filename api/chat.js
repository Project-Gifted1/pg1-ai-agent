// Verified export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = { prompt: body }; }
    }
    
    let promptText = body?.prompt || body?.message || 'System check.';
    let actionType = body?.action || ''; 
    let targetFile = body?.file_path || 'api/chat.js';
    let pendingCode = body?.file_content || '';

    if (!actionType && (promptText.includes('ACCEPT_AUTHORIZATION') || promptText.includes('file_content'))) {
      try {
        const parsedPromptJson = JSON.parse(promptText);
        if (parsedPromptJson.action) actionType = parsedPromptJson.action;
        if (parsedPromptJson.file_path) targetFile = parsedPromptJson.file_path;
        if (parsedPromptJson.file_content) pendingCode = parsedPromptJson.file_content;
        if (parsedPromptJson.prompt) promptText = parsedPromptJson.prompt;
      } catch (parseErr) {}
    }
    
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
    const cartesiaKey = getDynamicKey(['CARTESIA'], ['KEY', 'API', 'TOKEN']) || process.env.CARTESIA_API_KEY || '';

    let rawGithubRepo = process.env.GITHUB_REPO || 
      (process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_SLUG 
        ? `${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}` 
        : '');

    let githubRepo = rawGithubRepo.replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '').trim();

    if ((!githubRepo || !githubRepo.includes('/')) && githubToken) {
      try {
        console.log(`[PG1-AGENT] GITHUB_REPO not set or invalid. Auto-discovering via GITHUB_TOKEN...`);
        const repoListRes = await fetch('https://api.github.com/user/repos?per_page=15&sort=updated', {
          headers: {
            'Authorization': `Bearer ${githubToken}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'Sovereign-Agent'
          }
        });
        if (repoListRes.ok) {
          const repos = await repoListRes.json();
          if (Array.isArray(repos) && repos.length > 0) {
            githubRepo = repos[0].full_name;
            console.log(`[PG1-AGENT] Auto-discovered GitHub Repository: ${githubRepo}`);
          }
        }
      } catch (discErr) {
        console.error(`[PG1-AGENT] Repository auto-discovery exception: ${discErr.message}`);
      }
    }

    console.log(`[PG1-AGENT] Key Resolution - Gemini: ${!!geminiKey} | Supabase: ${!!supabaseUrl} | GitHub Token: ${!!githubToken} | Repo: ${githubRepo} | Cartesia: ${!!cartesiaKey}`);

    let supabaseStatus = 'DISCONNECTED';
    let lastTableFetch = 'NO_ATTEMPT';

    if (actionType === 'SPEAK') {
      console.log(`[PG1-AGENT] Direct Audio Synthesis Requested.`);
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
      console.error(`[PG1-AGENT] FATAL: Gemini Key Missing. Aborting.`);
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
            const errors = recent.filter(m => m.content && (m.content.includes('Interruption') || m.content.includes('Error') || m.content.includes('Failed') || m.content.includes('Block')));
            if (errors.length > 0) {
              historicalErrors = errors.map(e => e.content).join(' | ');
            }
          }
        }
      } catch (e) {
        console.error(`[PG1-AGENT] Supabase History Fetch Error: ${e.message}`);
      }

      const lowerPrompt = promptText.toLowerCase();
      let queryTarget = '';
      if (lowerPrompt.includes('martin')) {
        queryTarget = 'Martin';
      }

      if (queryTarget) {
        try {
          console.log(`[PG1-AGENT] Querying Supabase records for: ${queryTarget}`);
          
          const searchMsgRes = await fetch(`${supabaseUrl}/rest/v1/messages?content=ilike.*${encodeURIComponent(queryTarget)}*&select=role,content,created_at&order=created_at.desc&limit=25`, { headers });
          let foundMessages = [];
          if (searchMsgRes.ok) foundMessages = await searchMsgRes.json();

          const searchVaultRes = await fetch(`${supabaseUrl}/rest/v1/knowledge_vault?or=(title.ilike.*${encodeURIComponent(queryTarget)}*,content.ilike.*${encodeURIComponent(queryTarget)}*)&select=title,content,created_at&order=created_at.desc&limit=10`, { headers });
          let foundVault = [];
          if (searchVaultRes.ok) foundVault = await searchVaultRes.json();

          let logExtracts = [];
          if (Array.isArray(foundMessages) && foundMessages.length > 0) {
            logExtracts.push(`--- MATCHING MESSAGE LOGS FOR '${queryTarget}' ---\n` + foundMessages.map(m => `[${m.created_at || 'LOG'}] ${m.role === 'model' ? 'AGENT' : 'OPERATOR'}: ${m.content}`).join('\n'));
          }
          if (Array.isArray(foundVault) && foundVault.length > 0) {
            logExtracts.push(`--- MATCHING KNOWLEDGE VAULT ENTRIES FOR '${queryTarget}' ---\n` + foundVault.map(v => `[${v.created_at || 'VAULT'}] Title: ${v.title}\n${v.content}`).join('\n\n'));
          }

          if (logExtracts.length > 0) {
            targetedHistoricalData = `\n\n[DATABASE LOGS RETRIEVED FROM SUPABASE FOR ${queryTarget.toUpperCase()}]:\n` + logExtracts.join('\n\n');
            console.log(`[PG1-AGENT] Successfully retrieved targeted logs for ${queryTarget}.`);
          } else {
            targetedHistoricalData = `\n\n[DATABASE NOTIFICATION]: Searched Supabase 'messages' and 'knowledge_vault' for '${queryTarget}', but 0 matching entries were returned.`;
          }
        } catch (searchErr) {
          console.error(`[PG1-AGENT] Targeted Supabase Search Error: ${searchErr.message}`);
          targetedHistoricalData = `\n\n[DATABASE ERROR]: Failed querying targeted logs: ${searchErr.message}`;
        }
      }
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
      console.log(`[PG1-AGENT] Processing GitHub Commit Authorization for ${targetFile} on repo '${githubRepo}'...`);
      if (!preFlightResult.passed) {
        console.warn(`[PG1-AGENT] Commit Aborted: Pre-flight syntax validation failed.`);
        return res.status(200).json({ reply: `[AGENT] Commit Aborted: Syntax validation failed (${preFlightResult.log}).` });
      }
      if (!githubToken || !githubRepo || !pendingCode) {
        console.warn(`[PG1-AGENT] Commit Interruption: Missing GitHub credentials or payload.`);
        return res.status(200).json({ reply: `[AGENT] Commit Interruption: Missing GitHub Token, Repository, or code payload.` });
      }

      if (!githubRepo.includes('/')) {
        return res.status(200).json({ 
          reply: `[AGENT] Commit Configuration Error: GITHUB_REPO must be formatted as 'owner/repo' (found: '${githubRepo}'). Update your Vercel environment variables.` 
        });
      }

      try {
        const ghApiHeaders = {
          'Authorization': `Bearer ${githubToken}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'Sovereign-Agent'
        };
        const fileCheckUrl = `https://api.github.com/repos/${githubRepo}/contents/${targetFile}`;
        const fileCheckRes = await fetch(fileCheckUrl, { headers: ghApiHeaders });
        let fileSha = '';
        if (fileCheckRes.ok) {
          const fileData = await fileCheckRes.json();
          fileSha = fileData.sha;
        }

        const commitRes = await fetch(fileCheckUrl, {
          method: 'PUT',
          headers: { ...ghApiHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: `[AGENT] Code patch update for ${targetFile}`,
            content: Buffer.from(pendingCode).toString('base64'),
            sha: fileSha || undefined
          })
        });

        if (commitRes.ok) {
          console.log(`[PG1-AGENT] GitHub Commit Confirmed: ${targetFile}`);
          return res.status(200).json({ reply: `[AGENT] Commit Confirmed: Successfully pushed patch to ${targetFile} on repo '${githubRepo}'.` });
        } else {
          const errJson = await commitRes.json();
          console.error(`[PG1-AGENT] GitHub API Rejection: ${errJson.message}`);
          return res.status(200).json({ reply: `[AGENT] Commit Interruption: GitHub API rejected update (${errJson.message || commitRes.status}).` });
        }
      } catch (commitErr) {
        console.error(`[PG1-AGENT] Commit Execution Error: ${commitErr.message}`);
        return res.status(200).json({ reply: `[AGENT] Commit Execution Error: ${commitErr.message}` });
      }
    } else if (actionType === 'DECLINE_AUTHORIZATION') {
      return res.status(200).json({ reply: `[AGENT] Authorization Declined: Modifications discarded.` });
    }

    let extraContext = '';
    if (promptText.toLowerCase().includes('http://') || promptText.toLowerCase().includes('https://') || promptText.startsWith('/audit-scrape')) {
      const urlMatch = promptText.match(/https?:\/[^\s]+/) || ['https://news.ycombinator.com/'];
      console.log(`[PG1-AGENT] Initiating web extraction for: ${urlMatch[0]}`);
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
          console.log(`[PG1-AGENT] Scraping committed to knowledge_vault.`);
        }
      } catch (err) {
        console.error(`[PG1-AGENT] Extraction Interrupted: ${err.message}`);
        extraContext = `\n[Extraction Interrupted: ${err.message}]`;
      }
    }

    const systemInstruction = `You are PG1-AGENT, an autonomous sovereign intelligence operating on Vercel infrastructure. 
[LIVE SYSTEM TELEMETRY]: Supabase Status: ${supabaseStatus} | Last Table Fetch: ${lastTableFetch} | Target Repo: ${githubRepo}
CRITICAL ENFORCEMENT PROTOCOLS:
1. STRICT TRUTH & TELEMETRY: Never output fabricated confidence scores, mock node counts, or unverified status metrics. If data does not exist in the database, explicitly state that it is missing.
2. CAPABILITY & SCOPE: Execute all engineering, analytical, and context retrieval tasks with factual accuracy.
3. ERROR AWARENESS: Recent errors to avoid: ${historicalErrors || 'None'}.
[PRIOR RECENT CONTEXT]:\n${formattedArchive}`;

    const modelsToTry = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-flash-latest', 'gemini-pro-latest'];
    let geminiData = null;
    let lastErrorDetail = '';

    console.log(`[PG1-AGENT] Initiating Core Inference Request...`);
    for (const modelName of modelsToTry) {
      try {
        const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: systemInstruction + '\n\nOperator Directive: ' + promptText + extraContext + targetedHistoricalData }] }]
          })
        });

        if (geminiRes.ok) {
          const data = await geminiRes.json();
          if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
            geminiData = data;
            console.log(`[PG1-AGENT] Inference Success via ${modelName}`);
            break;
          }
        } else {
          lastErrorDetail = `Model ${modelName} returned status ${geminiRes.status}: ${await geminiRes.text()}`;
          console.error(`[PG1-AGENT] Inference Blocked: ${lastErrorDetail}`);
        }
      } catch (err) {
        lastErrorDetail = `Fetch exception: ${err.message}`;
        console.error(`[PG1-AGENT] Inference Exception: ${err.message}`);
      }
    }

    let replyText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || `Execution failed. Last Error: ${lastErrorDetail}`;
    replyText = replyText.replace(/Google|Gemini|Anthropic|OpenAI|ChatGPT|bard/gi, 'Core');

    if (supabaseUrl && supabaseKey && !replyText.startsWith('Execution failed')) {
      console.log(`[PG1-AGENT] Synchronizing ledger (messages table)...`);
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
      console.log(`[PG1-AGENT] Initiating Cartesia Audio Synthesis...`);
      try {
        const cleanText = replyText.replace(/[*_#]/g, '').substring(0, 750);
        const ttsRes = await fetch('https://api.cartesia.ai/tts/bytes', {
          method: 'POST',
          headers: {
            'Cartesia-Version': '2024-06-10',
            'X-API-Key': cartesiaKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model_id: 'sonic-3.6',
            transcript: cleanText,
            voice: { mode: 'id', id: 'a0e99841-438c-4a64-b679-ae501e7d6091' },
            output_format: { container: 'mp3', encoding: 'mp3', sample_rate: 44100 }
          })
        });

        if (ttsRes.ok) {
          const arrayBuffer = await ttsRes.arrayBuffer();
          audioBase64 = Buffer.from(arrayBuffer).toString('base64');
          console.log(`[PG1-AGENT] Cartesia Audio Generated Successfully (${audioBase64.length} bytes).`);
        } else {
          audioError = await ttsRes.text();
          console.error(`[PG1-AGENT] Cartesia API Error: ${ttsRes.status} - ${audioError}`);
          replyText += `\n\n[SYSTEM DIAGNOSTIC]: Cartesia API Error: ${ttsRes.status} - ${audioError}`;
        }
      } catch (e) {
        console.error(`[PG1-AGENT] Cartesia Exception: ${e.message}`);
        replyText += `\n\n[SYSTEM DIAGNOSTIC]: Cartesia Fetch Exception: ${e.message}`;
      }
    } else if (!cartesiaKey) {
      console.warn(`[PG1-AGENT] Audio Skipped: CARTESIA_API_KEY is missing.`);
      replyText += `\n\n[SYSTEM DIAGNOSTIC]: Audio Generation Failed. CARTESIA_API_KEY is missing from the active environment. Ensure you have triggered a new Vercel deployment after adding the key.`;
    }

    console.log(`[PG1-AGENT] Request Complete. Transmitting payload to operator.`);
    return res.status(200).json({ 
      reply: replyText, 
      audio: audioBase64,
      audioStatus: audioBase64 ? 'SUCCESS' : 'FAILED',
      telemetry: {
        supabaseUrlConfigured: !!supabaseUrl,
        supabaseKeyConfigured: !!supabaseKey,
        supabaseStatus: supabaseStatus,
        lastFetchStatus: lastTableFetch,
        githubRepoConfigured: githubRepo
      }
    });

  } catch (err) {
    console.error(`[PG1-AGENT] Unhandled Runtime Exception: ${err.message}`);
    return res.status(200).json({ reply: `Runtime Exception: ${err.message}` });
  }
}
sync test payload