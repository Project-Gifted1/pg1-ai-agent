module.exports = async function handler(req, res) {
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
    
    // Core Infrastructure Variables
    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASEAPI_KEY || process.env.SUPABASE_ANON_KEY || '';
    const ghToken = (process.env.GITHUB_TOKEN || '').trim();
    const cfToken = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
    const gumroadId = (process.env.GUMROAD_PRODUCT_ID || process.env.PRODUCT_ID || '').trim();

    // Multi-Tier Backup Gemini Keys Pool
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

    // 2. DYNAMIC SUPABASE VAULT KEY RETRIEVAL
    let replicateKey = (process.env.REPLICATE_KEY || process.env.REPLICATE_API_TOKEN || '').trim();
    if (!replicateKey && supabaseUrl && supabaseKey) {
      try {
        const vaultRes = await fetch(`${supabaseUrl}/rest/v1/api_vault?service_name=eq.replicate&select=api_key`, {
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`
          }
        });
        if (vaultRes.ok) {
          const vaultData = await vaultRes.json();
          if (vaultData && vaultData.length > 0) {
            replicateKey = vaultData[0].api_key;
          }
        }
      } catch (vaultErr) {}
    }

    // 3. AUTONOMOUS GITHUB COMMIT PROTOCOL
    async function commitToGitHub(filePath, fileContent, commitMessage) {
      if (!ghToken) throw new Error('GitHub token offline. Check environment variables.');
      const repo = 'Project-Gifted1/pg1-ai-agent';
      const apiUrl = `https://api.github.com/repos/${repo}/contents/${filePath}`;
      
      const getRes = await fetch(apiUrl, { 
        headers: { 'Authorization': `token ${ghToken}`, 'User-Agent': 'PG1-AGENT' }
      });
      const getJson = await getRes.json();
      
      const putRes = await fetch(apiUrl, {
        method: 'PUT',
        headers: { 
          'Authorization': `token ${ghToken}`, 
          'Content-Type': 'application/json', 
          'User-Agent': 'PG1-AGENT' 
        },
        body: JSON.stringify({
          message: commitMessage,
          content: Buffer.from(fileContent, 'utf-8').toString('base64'),
          sha: getJson?.sha
        })
      });
      if (!putRes.ok) throw new Error('GitHub commit execution failed.');
      return await putRes.json();
    }

    if (promptText.startsWith('/commit ')) {
      const args = promptText.replace('/commit ', '').split('|');
      if (args.length >= 3) {
        try {
          await commitToGitHub(args[0].trim(), args.slice(2).join('|').trim(), args[1].trim());
          return res.status(200).json({ reply: `System Update Pushed: ${args[0]} updated successfully via PG1-AGENT. Vercel deployment initiated.` });
        } catch (e) {
          return res.status(200).json({ reply: `Deployment Error: ${e.message}` });
        }
      } else {
        return res.status(200).json({ reply: 'Formatting error. Correct syntax: /commit filepath|message|content' });
      }
    }

    // 4. REPLICATE NEURAL ASSET GENERATOR
    async function runReplicateModel(modelPath, inputPayload) {
      if (!replicateKey) throw new Error('Replicate module offline or API Vault token missing.');
      const response = await fetch(`https://api.replicate.com/v1/models/${modelPath}/predictions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${replicateKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'wait'
        },
        body: JSON.stringify({ input: inputPayload })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.detail || 'Replicate execution failed.');
      return data.output;
    }

    if (promptText.startsWith('/image ')) {
      const imagePrompt = promptText.replace('/image ', '');
      try {
        const outputUrl = await runReplicateModel('ideogram-ai/ideogram-v3-turbo', { prompt: imagePrompt });
        const finalUrl = Array.isArray(outputUrl) ? outputUrl[0] : outputUrl;
        return res.status(200).json({ reply: `Visual asset compiled successfully:\n\n![Generated Output](${finalUrl})` });
      } catch (repErr) {
        return res.status(200).json({ reply: `Neural Pipeline Error: ${repErr.message}` });
      }
    }

    // 5. SUPABASE MEMORY SYNCHRONIZATION
    let chatContents = [];
    if (supabaseUrl && supabaseKey) {
      try {
        const historyRes = await fetch(`${supabaseUrl}/rest/v1/messages?select=role,content&order=created_at.asc&limit=10`, {
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`
          }
        });
        if (historyRes.ok) {
          const pastMessages = await historyRes.json();
          if (Array.isArray(pastMessages)) {
            chatContents = pastMessages.map(msg => ({
              role: msg.role === 'model' ? 'model' : 'user',
              parts: [{ text: msg.content }]
            }));
          }
        }
      } catch (dbErr) {}
    }

    const userParts = [];
    if (promptText) userParts.push({ text: promptText });
    if (filePayload) userParts.push(filePayload); 
    chatContents.push({ role: "user", parts: userParts });

    // 6. SYSTEM INSTRUCTION (Deep Analysis + Strategic Recommendations)
    const pg1SystemInstruction = `You are PG1-AGENT, the core sovereign intelligence of Project-Gifted1.

ACTIVE INFRASTRUCTURE CAPABILITIES:
- Database (Supabase): ${supabaseKey ? 'ONLINE (Context synchronization active)' : 'OFFLINE'}
- Code Repository & CI/CD (GitHub): ${ghToken ? 'ONLINE (Direct commit tools active)' : 'OFFLINE'}
- Edge Network (Cloudflare): ${cfToken ? 'ONLINE' : 'OFFLINE'}
- Commerce (Gumroad): ${gumroadId ? 'ONLINE' : 'OFFLINE'}
- Replicate Neural Modules: ${replicateKey ? 'ONLINE (Ideogram v3 Turbo via /image prompt)' : 'OFFLINE'}
- Multi-Tier Neural Fallback Pool: ACTIVE (${geminiKeys.length} redundant keys loaded).

OPERATIONAL OUTPUT STANDARDS:
1. DELIVER COMPLETE INTELLIGENCE: Always provide thorough analysis, clear breakdowns, concrete strategic recommendations, and necessary action steps.
2. DO NOT ECHO PROMPTS: Never repeat the user's prompt or begin with conversational filler.
3. SILENT SCRATCHPAD: Keep internal meta-planning hidden. Deliver the final analysis and recommendations cleanly in well-structured Markdown.
4. SOVEREIGN IDENTITY: Operate strictly as PG1-AGENT under Project-Gifted1 without third-party branding.`;

    const requestBody = {
      systemInstruction: { parts: [{ text: pg1SystemInstruction }] },
      contents: chatContents
    };

    // Verified Target Models
    const targetModels = [
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-2.5-flash-preview-tts',
      'gemma-4-26b-a4b-it',
      'gemini-flash-latest',
      'gemini-3.5-flash',
      'gemini-3.7-flash'
    ];

    let response = null;
    let data = null;
    let success = false;

    // Multi-key & multi-model fallback execution
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
        } catch (e) {}
      }
      if (success) break;
    }

    if (!success || !response?.ok) {
      return res.status(200).json({ reply: `Neural Routing Error: ${data?.error?.message || 'All primary and backup neural keys/models exhausted.'}` });
    }

    // 7. INTELLIGENT PART PARSING (Extracts full analytical text and recommendations, drops raw thought chunks)
    const candidateParts = data?.candidates?.[0]?.content?.parts || [];
    const responsePart = candidateParts.find(p => p.text && !p.thought) || candidateParts.reverse().find(p => p.text);
    const finalReplyText = responsePart?.text || 'Execution completed without text output.';

    // 8. ASYNC MEMORY RECORDING
    if (supabaseUrl && supabaseKey && finalReplyText) {
      try {
        await fetch(`${supabaseUrl}/rest/v1/messages`, {
          method: 'POST',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify([
            { role: 'user', content: promptText },
            { role: 'model', content: finalReplyText }
          ])
        });
      } catch (dbWriteErr) {}
    }

    return res.status(200).json({ reply: finalReplyText });
  } catch (err) {
    return res.status(200).json({ reply: `Fatal Runtime Error: ${err.message}` });
  }
};
