export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = { prompt: body }; }
    }
    
    let promptText = body?.prompt || body?.message || 'System check.';
    
    if (promptText === 'AUTH_VERIFY') {
      const inputUser = (body?.user || '').trim();
      const inputPass = (body?.pass || '').trim();
      const adminUser = (process.env.USER_API_KEY || '').trim();
      const adminPass = (process.env.USER_API_PASS || '').trim();

      if (inputUser === adminUser && inputPass === adminPass) {
        return res.status(200).json({ authenticated: true });
      } else {
        return res.status(200).json({ authenticated: false });
      }
    }

    const filePayload = body?.file; 
    
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
      return res.status(200).json({ reply: 'Config Error: No Gemini API keys found in environment variables.' });
    }

    if (promptText.startsWith('/vault ')) {
      const args = promptText.replace('/vault ', '').split(' ');
      if (args.length >= 2 && supabaseUrl && supabaseKey) {
        const serviceName = args[0].trim();
        const apiToken = args[1].trim();
        try {
          const upsertRes = await fetch(`${supabaseUrl}/rest/v1/api_vault`, {
            method: 'POST',
            headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
            body: JSON.stringify({ service_name: serviceName, api_key: apiToken })
          });
          if (upsertRes.ok) return res.status(200).json({ reply: `[SECURITY] Key for '${serviceName}' successfully encrypted and stored in Supabase Vault.` });
          else return res.status(200).json({ reply: `[ERROR] Vault storage failed. Ensure api_vault table exists.` });
        } catch (e) { return res.status(200).json({ reply: `[ERROR] Vault execution failed: ${e.message}` }); }
      }
      return res.status(200).json({ reply: 'Formatting error. Syntax: /vault service_name api_key' });
    }

    if (promptText.startsWith('/poll ')) {
      const predId = promptText.replace('/poll ', '').trim();
      try {
        const replicateKey = (process.env.REPLICATE_KEY || process.env.REPLICATE_API_TOKEN || '').trim();
        if (!replicateKey) {
          return res.status(200).json({ reply: 'Polling Error: Replicate API token environment variable is missing.' });
        }
        
        const checkRes = await fetch(`https://api.replicate.com/v1/predictions/${predId}`, {
          headers: { 'Authorization': `Bearer ${replicateKey}`, 'Content-Type': 'application/json' }
        });
        
        if (!checkRes.ok) {
          return res.status(200).json({ reply: `Replicate API Error: HTTP ${checkRes.status}` });
        }
        
        const predData = await checkRes.json();
        
        if (predData.status === 'succeeded') {
          const finalUrl = Array.isArray(predData.output) ? predData.output[0] : predData.output;
          return res.status(200).json({ reply: `Video asset compiled:\n\n<video controls playsinline webkit-playsinline="true" preload="metadata" style="width:100%;border-radius:8px;background:#000;"><source src="${finalUrl}" type="video/mp4"></video>\n\nDirect Download: ${finalUrl}` });
        } else if (predData.status === 'failed') {
          return res.status(200).json({ reply: `Prediction Failed: ${predData.error || 'Unknown error'}` });
        } else {
          return res.status(200).json({ reply: `Prediction Status: ${predData.status}. Still processing... Run /poll ${predId} again shortly.` });
        }
      } catch (e) {
        return res.status(200).json({ reply: `Polling Exception: ${e.message}` });
      }
    }

    if (promptText === '/init-vault') {
      try {
        const bucketRes = await fetch(`${supabaseUrl}/storage/v1/bucket`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'pg1-vault', name: 'pg1-vault', public: true })
        });
        const bucketData = await bucketRes.json();
        if (bucketRes.ok) return res.status(200).json({ reply: 'Storage vault `pg1-vault` has been provisioned.' });
        else {
          if (bucketData.message?.includes('already exists')) return res.status(200).json({ reply: 'Storage vault `pg1-vault` already exists.' });
          return res.status(200).json({ reply: `Vault provisioning failed: ${bucketData.message || JSON.stringify(bucketData)}` });
        }
      } catch (err) { return res.status(200).json({ reply: `Vault provisioning error: ${err.message}` }); }
    }

    async function commitToGitHub(filePath, fileContent, commitMessage) {
      if (!ghToken) throw new Error('GitHub token offline.');
      const repo = 'Project-Gifted1/pg1-ai-agent';
      const apiUrl = `https://api.github.com/repos/${repo}/contents/${filePath}`;
      let sha = undefined;
      try {
        const getRes = await fetch(apiUrl, { headers: { 'Authorization': `token ${ghToken}`, 'User-Agent': 'PG1-AGENT' }});
        if (getRes.ok) { const getJson = await getRes.json(); sha = getJson?.sha; }
      } catch (e) {}
      const putRes = await fetch(apiUrl, {
        method: 'PUT', headers: { 'Authorization': `token ${ghToken}`, 'Content-Type': 'application/json', 'User-Agent': 'PG1-AGENT' },
        body: JSON.stringify({ message: commitMessage, content: Buffer.from(fileContent, 'utf-8').toString('base64'), sha: sha })
      });
      if (!putRes.ok) { const errJson = await putRes.json().catch(() => ({})); throw new Error(errJson.message || 'GitHub commit failed.'); }
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
        } catch (e) { return res.status(200).json({ reply: `Deployment Error: ${e.message}` }); }
      } else { return res.status(200).json({ reply: 'Formatting error. Syntax: /commit filepath|message|content' }); }
    }

    async function startReplicatePrediction(modelPath, inputPayload) {
      let replicateKey = '';
      if (supabaseUrl && supabaseKey) {
        try {
          const vaultRes = await fetch(`${supabaseUrl}/rest/v1/api_vault?service_name=eq.replicate&select=api_key`, { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } });
          if (vaultRes.ok) { const vaultData = await vaultRes.json(); if (vaultData && vaultData.length > 0) replicateKey = vaultData[0].api_key; }
        } catch (vaultErr) {}
      }
      if (!replicateKey) replicateKey = (process.env.REPLICATE_KEY || process.env.REPLICATE_API_TOKEN || '').trim();
      if (!replicateKey) throw new Error('Replicate key missing from Vault.');
      const response = await fetch(`https://api.replicate.com/v1/models/${modelPath}/predictions`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${replicateKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ input: inputPayload })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.detail || 'Replicate initialization failed.');
      return data;
    }

    if (promptText.startsWith('/image ')) {
      try {
        const pred = await startReplicatePrediction('ideogram-ai/ideogram-v3-turbo', { prompt: promptText.replace('/image ', '') });
        return res.status(200).json({ reply: `Visual generation initialized instantly.\n\nPrediction ID: \`${pred.id}\`\n\nRun \`/poll ${pred.id}\` when ready.` });
      } catch (repErr) { return res.status(200).json({ reply: `Neural Pipeline Error: ${repErr.message}` }); }
    }

    if (promptText.startsWith('/video ')) {
      try {
        const pred = await startReplicatePrediction('minimax/video-01', { prompt: promptText.replace('/video ', '') });
        return res.status(200).json({ reply: `Video generation initialized successfully.\n\nPrediction ID: \`${pred.id}\`\n\nTo check status and load player, run:\n\`/poll ${pred.id}\`` });
      } catch (repErr) { return res.status(200).json({ reply: `Neural Pipeline Error: ${repErr.message}` }); }
    }

    let chatContents = [];
    if (supabaseUrl && supabaseKey) {
      try {
        const historyRes = await fetch(`${supabaseUrl}/rest/v1/messages?select=role,content&order=created_at.desc&limit=30`, { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } });
        if (historyRes.ok) {
          const pastMessages = await historyRes.json();
          if (Array.isArray(pastMessages)) chatContents = pastMessages.reverse().map(msg => ({ role: msg.role === 'model' ? 'model' : 'user', parts: [{ text: msg.content }] }));
        }
      } catch (dbErr) {}
    }

    const userParts = [];
    if (promptText) userParts.push({ text: promptText });
    if (filePayload) userParts.push(filePayload); 

    chatContents.push({ role: "user", parts: userParts });

    const pg1SystemInstruction = "You are PG1-AGENT, the core sovereign intelligence of Project-Gifted1.";
    const requestBody = { systemInstruction: { parts: [{ text: pg1SystemInstruction }] }, contents: chatContents };
    const targetModels = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-flash-latest'];
    let response = null, data = null, success = false;

    for (const key of geminiKeys) {
      for (const model of targetModels) {
        try {
          response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) });
          data = await response.json();
          if (response.ok && data?.candidates?.[0]) { success = true; break; }
        } catch (e) {}
      }
      if (success) break;
    }

    if (!success || !response?.ok) {
      const errDetail = data?.error?.message || response?.statusText || 'Unknown gateway failure';
      return res.status(200).json({ reply: `Neural Gateway Error: ${errDetail}` });
    }

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
