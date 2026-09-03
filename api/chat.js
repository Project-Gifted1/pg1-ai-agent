import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText, tool } from 'ai';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';

export const maxDuration = 60;

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
    
    // Auth Verify Handler for UI
    if (promptText === 'AUTH_VERIFY') {
      const inputUser = (body?.user || '').trim();
      const inputPass = (body?.pass || '').trim();
      const adminUser = (process.env.USER_API_KEY || '').trim();
      const adminPass = (process.env.USER_API_PASS || '').trim();
      return res.status(200).json({ authenticated: inputUser === adminUser && inputPass === adminPass });
    }

    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASEAPI_KEY || process.env.SUPABASE_ANON_KEY || '';
    const replicateToken = (process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_KEY || '').trim();

    const geminiKeys = [
      (process.env.GEMINI_API_KEY1 || '').trim(),
      (process.env.GEMINI_API_KEY || '').trim()
    ].filter(Boolean);

    if (geminiKeys.length === 0) {
      return res.status(200).json({ reply: 'Config Error: No Gemini API keys found.' });
    }

    // Manual Commands
    if (promptText.startsWith('/vault ')) {
      const args = promptText.replace('/vault ', '').split(' ');
      if (args.length >= 2 && supabaseUrl && supabaseKey) {
        const upsertRes = await fetch(`${supabaseUrl}/rest/v1/api_vault`, {
          method: 'POST',
          headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
          body: JSON.stringify({ service_name: args[0].trim(), api_key: args[1].trim() })
        });
        return res.status(200).json({ reply: upsertRes.ok ? '[SECURITY] Key stored in Vault.' : '[ERROR] Vault storage failed.' });
      }
      return res.status(200).json({ reply: 'Syntax: /vault service_name api_key' });
    }

    if (promptText.startsWith('/poll ')) {
      const predId = promptText.replace('/poll ', '').trim();
      try {
        if (!replicateToken) return res.status(200).json({ reply: 'Replicate token missing.' });
        const checkRes = await fetch(`https://api.replicate.com/v1/predictions/${predId}`, {
          headers: { 'Authorization': `Bearer ${replicateToken}`, 'Content-Type': 'application/json' }
        });
        const predData = await checkRes.json();
        if (predData.status === 'succeeded') {
          const finalUrl = Array.isArray(predData.output) ? predData.output[0] : predData.output;
          return res.status(200).json({ reply: `Asset compiled:\n<img src="${finalUrl}" style="width:100%;border-radius:8px;" />\nLink: ${finalUrl}` });
        }
        return res.status(200).json({ reply: `Status: ${predData.status}. Run /poll ${predId} again shortly.` });
      } catch (e) { return res.status(200).json({ reply: `Polling Error: ${e.message}` }); }
    }

    // Autonomous AI Execution
    let supabase = null;
    let chatHistory = [];
    let formattedArchive = 'No prior context.';

    if (supabaseUrl && supabaseKey) {
      supabase = createClient(supabaseUrl, supabaseKey);
      try {
        const { data: recent } = await supabase.from('messages').select('role, content').order('created_at', { ascending: false }).limit(15);
        if (recent?.length > 0) {
          chatHistory = recent.reverse().map(m => ({ role: (m.role === 'model' || m.role === 'assistant') ? 'assistant' : 'user', content: m.content }));
          formattedArchive = chatHistory.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
        }
      } catch (e) {}
    }

    const systemPrompt = `You are PG1-AGENT, sovereign executive intelligence for Project-Gifted1.
You operate across 1,500 sovereign nodes. Use tools autonomously to scrape URLs, read/write vault, and generate images.
[VAULT ARCHIVE]
${formattedArchive}`;

    const conversation = [...chatHistory, { role: 'user', content: promptText }];
    const googleProvider = createGoogleGenerativeAI({ apiKey: geminiKeys[0] });

    const { text } = await generateText({
      model: googleProvider('models/gemini-1.5-pro-latest'),
      system: systemPrompt,
      messages: conversation,
      maxSteps: 5,
      tools: {
        scrape_url: tool({
          description: 'Extract raw text from a live URL.',
          parameters: z.object({ url: z.string().url() }),
          execute: async ({ url }) => {
            try {
              const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
              const html = await r.text();
              const $ = cheerio.load(html);
              $('script, style, noscript, svg, img').remove();
              return { content: $('body').text().replace(/\s+/g, ' ').substring(0, 10000) };
            } catch (err) { return { error: err.message }; }
          }
        }),
        write_vault: tool({
          description: 'Save data into knowledge_vault table.',
          parameters: z.object({ title: z.string(), content: z.string() }),
          execute: async ({ title, content }) => {
            if (!supabase) return { error: 'DB offline.' };
            await supabase.from('knowledge_vault').insert([{ title, content }]);
            return { success: true, message: `Saved: ${title}` };
          }
        })
      }
    });

    if (supabase && text) {
      await supabase.from('messages').insert([{ role: 'user', content: promptText }, { role: 'model', content: text }]);
    }

    return res.status(200).json({ reply: text });
  } catch (err) {
    return res.status(500).json({ reply: `Fatal Error: ${err.message}` });
  }
}
