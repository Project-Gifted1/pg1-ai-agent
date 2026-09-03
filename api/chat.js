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
    
    const geminiKey = (process.env.GEMINI_API_KEY1 || process.env.GEMINI_API_KEY || '').trim();
    if (!geminiKey) {
      return res.status(200).json({ reply: 'Config Error: GEMINI_API_KEY is missing from Vercel environment variables.' });
    }

    let supabase = null;
    let chatHistory = [];
    let formattedArchive = 'No prior context.';

    if (supabaseUrl && supabaseKey) {
      supabase = createClient(supabaseUrl, supabaseKey);
      try {
        const { data: recent } = await supabase.from('messages').select('role, content').order('created_at', { ascending: false }).limit(10);
        if (recent?.length > 0) {
          chatHistory = recent.reverse().map(m => ({ role: (m.role === 'model' || m.role === 'assistant') ? 'assistant' : 'user', content: m.content }));
          formattedArchive = chatHistory.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
        }
      } catch (e) {}
    }

    const systemPrompt = `You are PG1-AGENT, sovereign executive intelligence for Project-Gifted1.
[VAULT ARCHIVE]
${formattedArchive}`;

    const conversation = [...chatHistory, { role: 'user', content: promptText }];
    const googleProvider = createGoogleGenerativeAI({ apiKey: geminiKey });

    const { text } = await generateText({
      model: googleProvider('models/gemini-1.5-pro-latest'),
      system: systemPrompt,
      messages: conversation,
      maxSteps: 3,
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
              return { content: $('body').text().replace(/\s+/g, ' ').substring(0, 5000) };
            } catch (err) { return { error: err.message }; }
          }
        })
      }
    });

    if (supabase && text) {
      await supabase.from('messages').insert([{ role: 'user', content: promptText }, { role: 'model', content: text }]);
    }

    return res.status(200).json({ reply: text });
  } catch (err) {
    return res.status(200).json({ reply: `Runtime Recovery Catch: ${err.message}` });
  }
}
