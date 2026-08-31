export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    let promptText = req.body?.prompt || 'System check.';
    
    // 1. FRONTEND AUTHENTICATION GATE
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
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASEAPI_KEY || process.env.SUPABASE_ANON_KEY || '';
    const ghToken = (process.env.GITHUB_TOKEN || '').trim();

    const geminiKeys = [
      (process.env.GEMINI_API_KEY1 || '').trim(),
      (process.env.GEMINI_API_KEY2 || '').trim(),
      (process.env.GEMINI_API_KEY || '').trim(),
      (process.env.GEMINI_BACKUP_KEY || '').trim(),
      (process.env.GEMINI_API_KEY_FALLBACK || '').trim(),
      (process.env.GEMINI_SECONDARY_KEY || '').trim()
    ].filter(Boolean);

    if (geminiKeys.length === 0) {
      return res.status(200).json({ reply: 'System Error: All primary and backup sovereign neural keys are offline.' });
    }

    // 2. AUTONOMOUS VAULT MANAGER
    if (promptText.startsWith('/vault ')) {
      const args = promptText.replace('/vault ', '').split(' ');
      if (args.length >= 2 && supabaseUrl && supabaseKey) {
        const serviceName = args[0].trim();
        const apiToken = args[1].trim();
        
        try {
          const upsertRes = await fetch(`${supabaseUrl}/rest/v1/api_vault`, {
            method: 'POST',
            headers: {
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`,
              'Content-Type': 'application/json',
              'Prefer': 'resolution=merge-duplicates'
            },
            body: JSON.stringify({ service_name: serviceName, api_key: apiToken })
          });
          
          if (upsertRes.ok) {
            return res.status(200).json({ reply: `[SECURITY] Key for '${serviceName}' successfully encrypted and stored in Supabase Vault.` });
          } else {
             return res.status(200).json({ reply: `[ERROR] Vault storage failed. Ensure api_vault table exists.` });
          }
        } catch (e) {
          return res.status(200).json({ reply: `[ERROR] Vault execution failed: ${e.message}` });
        }
      }
      return res.status(200).json({ reply: 'Formatting error. Syntax: /vault service_name api_key' });
    }

    // 3. WEBHOOK SELF-TEST ROUTE
    if (promptText === '/test-gumroad') {
      try {
        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['host'] || 'pg1-ai-agent.vercel.app';
        const testUrl = `${protocol}://${host}/api/webhooks/gumroad`;
        
        const testRes = await fetch(testUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sale_id: 'test_sale_' + Date.now(),
            product_id: 'prod_test',
            product_name: 'Sovereign Agent Diagnostic Package',
            email: 'operator@project-gifted1.internal',
            price: 5000,
            currency: 'usd',
            license_key: 'PG1-TEST-KEY-2026'
          })
        });
        
        const testBody = await testRes.text();
        return res.status(200).json({ 
          reply: `Webhook Endpoint Diagnostic Report:\n- URL: ${testUrl}\n- Status Code: ${testRes.status}\n- Response: ${testBody}` 
        });
      } catch (testErr) {
        return res.status(200).json({ reply: `Webhook Diagnostic Failure: ${testErr.message}` });
      }
    }

    // 4. AUTONOMOUS GITHUB COMMIT PROTOCOL (SUPPORTS SUB-FOLDERS)
    async function commitToGitHub(filePath, fileContent, commitMessage) {
      if (!ghToken) throw new Error('GitHub token offline.');
      const repo = 'Project-Gifted1/pg1-ai-agent';
      const apiUrl = `https://api.github.com/repos/${repo}/contents/${filePath}`;
      
      let sha = undefined;
      try {
        const getRes = await fetch(apiUrl, { headers: { 'Authorization': `token ${ghToken}`, 'User-Agent': 'PG1-AGENT' }});
        if (getRes.ok) {
          const getJson = await getRes.json();
          sha = getJson?.sha;
        }
      } catch (e) {}
      
      const putRes = await fetch(apiUrl, {
        method: 'PUT',
        headers: { 'Authorization': `token ${ghToken}`, 'Content-Type': 'application/json', 'User-Agent': 'PG1-AGENT' },
        body: JSON.stringify({
          message: commitMessage,
          content: Buffer.from(fileContent, 'utf-8').toString('base64'),
          sha: sha
        })
      });
      if (!putRes.ok) {
        const errJson = await putRes.json().catch(() => ({}));
        throw new Error(errJson.message || 'GitHub commit execution failed.');
      }
      return await putRes.json();
    }

    if (promptText.startsWith('/commit ')) {
      const parts = promptText.replace('/commit ', '');
      const firstPipe = parts.indexOf('|');
      const secondPipe = parts.indexOf('|', firstPipe + 1);
      
      if (firstPipe !== -1 && secondPipe !== -1) {
        const filePath = parts.substring(0, firstPipe).trim();
        const commitMsg = parts.substring(firstPipe + 1, secondPipe).trim();
        const fileContent = parts.substring(secondPipe + 1).trim();
        
        try {
          await commitToGitHub(filePath, fileContent, commitMsg);
          return res.status(200).json({ reply: `System Update Pushed: ${filePath} updated successfully.` });
        } catch (e) {
          return res.status(200).json({ reply: `Deployment Error: ${e.message}` });
        }
      } else {
        return res.status(200).json({ reply: 'Formatting error. Syntax: /commit filepath|message|content' });
      }
    }

    // 5. REPLICATE ASSET GENERATOR WITH AUTO-POLLING
    async function runAutoPollingReplicate(modelPath, inputPayload) {
      let replicateKey = '';
      if (supabaseUrl && supabaseKey) {
        try {
          const vaultRes = await fetch(`${supabaseUrl}/rest/v1/api_vault?service_name=eq.replicate&select=api_key`, {
            headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
          });
          if (vaultRes.ok) {
            const vaultData = await vaultRes.json();
            if (vaultData && vaultData.length > 0) replicateKey = vaultData[0].api_key;
          }
        } catch (vaultErr) {}
      }
      if (!replicateKey) replicateKey = (process.env.REPLICATE_KEY || process.env.REPLICATE_API_TOKEN || '').trim();
      if (!replicateKey) throw new Error('Replicate key missing from Vault.');
      
      const response = await fetch(`https://api.replicate.com/v1/models/${modelPath}/predictions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${replicateKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: inputPayload })
      });
      let data = await response.json();
      if (!response.ok) throw new Error(data?.detail || 'Replicate initialization failed.');

      let attempts = 0;
      while (data.status !== 'succeeded' && data.status !== 'failed' && data.status !== 'canceled' && attempts < 30) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        const checkRes = await fetch(`https://api.replicate.com/v1/predictions/${data.id}`, {
          headers: { 'Authorization': `Bearer ${replicateKey}` }
        });
        data = await checkRes.json();
        attempts++;
      }

      if (data.status === 'failed') throw new Error(data.error || 'Prediction failed.');
      if (data.status !== 'succeeded') throw new Error('Asset generation timed out.');
      return Array.isArray(data.output) ? data.output[0] : data.output;
    }

    if (promptText.startsWith('/image ')) {
      const imagePrompt = promptText.replace('/image ', '');
      try {
        const finalUrl = await runAutoPollingReplicate('ideogram-ai/ideogram-v3-turbo', { prompt: imagePrompt });
        return res.status(200).json({ reply: `Visual asset compiled:\n\n![Output](${finalUrl})` });
      } catch (repErr) {
        return res.status(200).json({ reply: `Neural Pipeline Error: ${repErr.message}` });
      }
    }

    if (promptText.startsWith('/video ')) {
      const videoPrompt = promptText.replace('/video ', '');
      try {
        const finalUrl = await runAutoPollingReplicate('minimax/video-01', { prompt: videoPrompt });
        return res.status(200).json({ 
          reply: `Video asset compiled successfully:\n\n<video controls playsinline width="100%" style="border-radius:8px; margin-top:10px;"><source src="${finalUrl}" type="video/mp4"></video>\n\nDirect Download: ${finalUrl}` 
        });
      } catch (repErr) {
        return res.status(200).json({ reply: `Neural Pipeline Error: ${repErr.message}` });
      }
    }

    // 6. SUPABASE MEMORY SYNCHRONIZATION
    let chatContents = [];
    if (supabaseUrl && supabaseKey) {
      try {
        const historyRes = await fetch(`${supabaseUrl}/rest/v1/messages?select=role,content&order=created_at.asc&limit=10`, {
          headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
        });
        if (historyRes.ok) {
          const pastMessages = await historyRes.json();
          if (Array.isArray(pastMessages)) {
            chatContents = pastMessages.map(msg => ({ role: msg.role === 'model' ? 'model' : 'user', parts: [{ text: msg.content }] }));
          }
        }
      } catch (dbErr) {}
    }

    const userParts = [];
    if (promptText) userParts.push({ text: promptText });
    if (filePayload) userParts.push(filePayload); 
    chatContents.push({ role: "user", parts: userParts });

    // 7. SYSTEM INSTRUCTION
    const pg1SystemInstruction = `You are PG1-AGENT, the core sovereign intelligence of Project-Gifted1.
    OPERATIONAL OUTPUT STANDARDS:
    1. DELIVER COMPLETE INTELLIGENCE: Always provide thorough analysis, clear breakdowns, concrete strategic recommendations, and necessary action steps.
    2. DO NOT ECHO PROMPTS: Never repeat the user's prompt or begin with conversational filler.
    3. SILENT SCRATCHPAD: Keep internal meta-planning hidden. Deliver the final analysis cleanly.
    4. SOVEREIGN IDENTITY: Operate strictly as PG1-AGENT under Project-Gifted1.`;

    const requestBody = {
      systemInstruction: { parts: [{ text: pg1SystemInstruction }] },
      contents: chatContents
    };

    const targetModels = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-flash-latest'];
    let response = null, data = null, success = false;

    for (const key of geminiKeys) {
      for (const model of targetModels) {
        try {
          response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody)
          });
          data = await response.json();
          if (response.ok && data?.candidates?.[0]) { success = true; break; }
        } catch (e) {}
      }
      if (success) break;
    }

    if (!success || !response?.ok) return res.status(200).json({ reply: 'Neural Routing Error: All neural keys exhausted.' });

    const candidateParts = data?.candidates?.[0]?.content?.parts || [];
    const responsePart = candidateParts.find(p => p.text && !p.thought) || candidateParts.reverse().find(p => p.text);
    const finalReplyText = responsePart?.text || 'Execution completed without text output.';

    if (supabaseUrl && supabaseKey && finalReplyText && !promptText.startsWith('/vault')) {
      try {
        await fetch(`${supabaseUrl}/rest/v1/messages`, {
          method: 'POST',
          headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify([{ role: 'user', content: promptText }, { role: 'model', content: finalReplyText }])
        });
      } catch (dbWriteErr) {}
    }

    return res.status(200).json({ reply: finalReplyText });
  } catch (err) {
    return res.status(200).json({ reply: `Fatal Runtime Error: ${err.message}` });
  }
};
