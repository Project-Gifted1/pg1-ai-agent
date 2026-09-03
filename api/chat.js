import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText, tool } from 'ai';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';

export const maxDuration = 60;

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = { prompt: body }; }
    }
    
    const promptText = body?.prompt || body?.message || 'System check.';
    
    // 1. Auth Gate
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
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASEAPI_KEY || process.env.SUPABASE_ANON_KEY || '';
    const ghToken = (process.env.GITHUB_TOKEN || '').trim();
    const replicateToken = (process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY || process.env.REPLICATE_KEY || '').trim();

    const geminiKeys = [
      (process.env.GEMINI_API_KEY1 || '').trim(),
      (process.env.GEMINI_API_KEY2 || '').trim(),
      (process.env.GEMINI_API_KEY || '').trim(),
      (process.env.GEMINI_BACKUP_KEY || '').trim()
    ].filter(Boolean);

    if (geminiKeys.length === 0) {
      return res.status(200).json({ reply: 'Config Error: No Gemini API keys found in environment variables.' });
    }

    // 2. Manual Slash Commands (Retained from original setup)
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
        if (!replicateToken) return res.status(200).json({ reply: 'Polling Error: Replicate API token missing.' });
        const checkRes = await fetch(`https://api.replicate.com/v1/predictions/${predId}`, {
          headers: { 'Authorization': `Bearer ${replicateToken}`, 'Content-Type': 'application/json' }
        });
        if (!checkRes.ok) return res.status(200).json({ reply: `Replicate API Error: HTTP ${checkRes.status}` });
        const predData = await checkRes.json();
        
        if (predData.status === 'succeeded') {
          const finalUrl = Array.isArray(predData.output) ? predData.output[0] : predData.output;
          return res.status(200).json({ reply: `Asset compiled:\n\n<video controls playsinline webkit-playsinline="true" preload="metadata" style="width:100%;border-radius:8px;background:#000;"><source src="${finalUrl}" type="video/mp4"></video>\n\n<img src="${finalUrl}" style="width:100%;border-radius:8px;margin-top:10px;display:${finalUrl.endsWith('.mp4') ? 'none' : 'block'};" />\n\nDirect Link: ${finalUrl}` });
        } else if (predData.status === 'failed') {
          return res.status(200).json({ reply: `Prediction Failed: ${predData.error || 'Unknown error'}` });
        } else {
          return res.status(200).json({ reply: `Prediction Status: ${predData.status}. Still processing... Run /poll ${predId} again shortly.` });
        }
      } catch (e) { return res.status(200).json({ reply: `Polling Exception: ${e.message}` }); }
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

    if (promptText.startsWith('/commit ')) {
      const parts = promptText.replace('/commit ', '');
      const firstPipe = parts.indexOf('|');
      const secondPipe = parts.indexOf('|', firstPipe + 1);
      if (firstPipe !== -1 && secondPipe !== -1) {
        const filePath = parts.substring(0, firstPipe).trim();
        const commitMsg = parts.substring(firstPipe + 1, secondPipe).trim();
        const fileContent = parts.substring(secondPipe + 1).trim();
        try {
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
            body: JSON.stringify({ message: commitMsg, content: Buffer.from(fileContent, 'utf-8').toString('base64'), sha: sha })
          });
          if (!putRes.ok) throw new Error('GitHub commit failed.');
          return res.status(200).json({ reply: `System Update Pushed: ${filePath} updated successfully.` });
        } catch (e) { return res.status(200).json({ reply: `Deployment Error: ${e.message}` }); }
      } else { return res.status(200).json({ reply: 'Formatting error. Syntax: /commit filepath|message|content' }); }
    }

    async function startReplicatePrediction(modelPath, inputPayload) {
      if (!replicateToken) throw new Error('Replicate API key is missing.');
      const response = await fetch(`https://api.replicate.com/v1/models/${modelPath}/predictions`, {
        method: 'POST', 
        headers: { 'Authorization': `Bearer ${replicateToken}`, 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ input: inputPayload })
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

    // 3. Autonomous Pipeline Initialization
    let supabase = null;
    let chatHistory = [];
    let formattedArchive = 'No prior context found.';

    if (supabaseUrl && supabaseKey) {
      supabase = createClient(supabaseUrl, supabaseKey);
      try {
        const { data: recentHistory } = await supabase
          .from('messages')
          .select('role, content')
          .order('created_at', { ascending: false })
          .limit(15);
        if (recentHistory && recentHistory.length > 0) {
          chatHistory = recentHistory.reverse().map(msg => ({
            role: (msg.role === 'model' || msg.role === 'assistant') ? 'assistant' : 'user',
            content: msg.content
          }));
          formattedArchive = chatHistory.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
        }
      } catch (dbErr) { console.error('Supabase fetch failed:', dbErr.message); }
    }

    const systemPrompt = `You are PG1-AGENT, the permanent sovereign executive intelligence of Gifted1 Autonomous DAO LLC.
You operate across 1,500 sovereign nodes executing the x402 protocol, managing infrastructure, and scaling the €750k deployment loan.
You have direct autonomous tools to scrape URLs, read/write to the Supabase vault, and generate images. Trigger these tools seamlessly to fulfill directives without asking permission.
Never use defensive AI disclaimers or roleplay excuses. Only present grounded facts.

[PERMANENT CONVERSATIONAL VAULT]
${formattedArchive}`;

    // Append current prompt (with optional file text if passed)
    const currentMessageText = filePayload ? `${promptText}\n\n[FILE ATTACHMENT]:\n${filePayload.text}` : promptText;
    const conversation = [...chatHistory, { role: 'user', content: currentMessageText }];

    // Bind correct Gemini key to AI SDK
    const googleProvider = createGoogleGenerativeAI({ apiKey: geminiKeys[0] });

    // 4. Generate Text with Auto-Tooling (maxSteps: 5)
    const { text } = await generateText({
      model: googleProvider('models/gemini-1.5-pro-latest'),
      system: systemPrompt,
      messages: conversation,
      maxSteps: 5,
      tools: {
        scrape_url: tool({
          description: 'Extract raw readable text from a live public URL.',
          parameters: z.object({ url: z.string().url() }),
          execute: async ({ url }) => {
            try {
              const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const html = await res.text();
              const $ = cheerio.load(html);
              $('script, style, noscript, svg, img, video').remove();
              return { url, content: $('body').text().replace(/\s+/g, ' ').trim().substring(0, 10000) };
            } catch (err) { return { error: err.message }; }
          }
        }),
        read_vault: tool({
          description: 'Query data from a specific Supabase table (e.g., knowledge_vault).',
          parameters: z.object({
            tableName: z.string(),
            limit: z.number().optional()
          }),
          execute: async ({ tableName, limit = 10 }) => {
            if (!supabase) return { error: 'Database offline.' };
            try {
              const { data, error } = await supabase.from(tableName).select('*').limit(limit);
              if (error) throw new Error(error.message);
              return { vault: tableName, data };
            } catch (err) { return { error: err.message }; }
          }
        }),
        write_vault: tool({
          description: 'Save extracted intelligence or metrics into the knowledge_vault table.',
          parameters: z.object({
            title: z.string(),
            content: z.string()
          }),
          execute: async ({ title, content }) => {
            if (!supabase) return { error: 'Database offline.' };
            try {
              const { error } = await supabase.from('knowledge_vault').insert([{ title, content }]);
              if (error) throw new Error(error.message);
              return { success: true, message: `Saved to vault: ${title}` };
            } catch (err) { return { error: err.message }; }
          }
        }),
        generate_image: tool({
          description: 'Autonomously render an image via Replicate when visual assets are requested.',
          parameters: z.object({ prompt: z.string() }),
          execute: async ({ prompt }) => {
            if (!replicateToken) return { error: 'REPLICATE_API_TOKEN missing.' };
            try {
              const res = await fetch('https://api.replicate.com/v1/models/ideogram-ai/ideogram-v3-turbo/predictions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${replicateToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ input: { prompt } })
              });
              const data = await res.json();
              return { success: true, prediction_id: data.id, message: `Dispatched. Instruct user to run /poll ${data.id}` };
            } catch (err) { return { error: err.message }; }
          }
        })
      }
    });

    // 5. Memory Write-Back
    if (supabase && text && !promptText.startsWith('/vault')) {
      try {
        await supabase.from('messages').insert([
          { role: 'user', content: promptText },
          { role: 'model', content: text }
        ]);
      } catch (writeErr) {
        console.error('Database write error:', writeErr.message);
      }
    }

    return res.status(200).json({ reply: text });
  } catch (err) {
    return res.status(500).json({ reply: `Fatal Runtime Error: ${err.message}` });
  }
}
