import { NextResponse } from 'next/server';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText, tool } from 'ai';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
    },
  });
}

export async function POST(req) {
  try {
    let body;
    try {
      body = await req.json();
    } catch (e) {
      body = { prompt: await req.text() };
    }
    
    const promptText = body?.prompt || body?.message || 'System check.';
    
    // 1. Auth Gate Verification
    if (promptText === 'AUTH_VERIFY') {
      const inputUser = (body?.user || '').trim();
      const inputPass = (body?.pass || '').trim();
      const adminUser = (process.env.USER_API_KEY || '').trim();
      const adminPass = (process.env.USER_API_PASS || '').trim();
      return NextResponse.json({ authenticated: inputUser === adminUser && inputPass === adminPass });
    }

    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASEAPI_KEY || process.env.SUPABASE_ANON_KEY || '';
    const ghToken = (process.env.GITHUB_TOKEN || '').trim();
    const replicateToken = (process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_KEY || '').trim();

    const geminiKeys = [
      (process.env.GEMINI_API_KEY1 || '').trim(),
      (process.env.GEMINI_API_KEY || '').trim()
    ].filter(Boolean);

    if (geminiKeys.length === 0) {
      return NextResponse.json({ reply: 'Config Error: No Gemini API keys found.' });
    }

    // 2. Manual Commands (/vault, /poll, /init-vault, /commit, /image, /video)
    if (promptText.startsWith('/vault ')) {
      const args = promptText.replace('/vault ', '').split(' ');
      if (args.length >= 2 && supabaseUrl && supabaseKey) {
        try {
          const res = await fetch(`${supabaseUrl}/rest/v1/api_vault`, {
            method: 'POST',
            headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
            body: JSON.stringify({ service_name: args[0].trim(), api_key: args[1].trim() })
          });
          return NextResponse.json({ reply: res.ok ? `[SECURITY] Key stored in Vault.` : `[ERROR] Vault storage failed.` });
        } catch (e) { return NextResponse.json({ reply: `[ERROR] ${e.message}` }); }
      }
      return NextResponse.json({ reply: 'Syntax: /vault service_name api_key' });
    }

    if (promptText.startsWith('/poll ')) {
      const predId = promptText.replace('/poll ', '').trim();
      try {
        if (!replicateToken) return NextResponse.json({ reply: 'Replicate API token missing.' });
        const checkRes = await fetch(`https://api.replicate.com/v1/predictions/${predId}`, {
          headers: { 'Authorization': `Bearer ${replicateToken}`, 'Content-Type': 'application/json' }
        });
        const predData = await checkRes.json();
        
        if (predData.status === 'succeeded') {
          const finalUrl = Array.isArray(predData.output) ? predData.output[0] : predData.output;
          return NextResponse.json({ reply: `Asset compiled:\n\n<video controls playsinline style="width:100%;border-radius:8px;background:#000;"><source src="${finalUrl}"></video>\n\n<img src="${finalUrl}" style="width:100%;border-radius:8px;margin-top:10px;display:${finalUrl.endsWith('.mp4') ? 'none' : 'block'};" />\n\nDirect Link: ${finalUrl}` });
        } else {
          return NextResponse.json({ reply: `Status: ${predData.status}. Run /poll ${predId} again shortly.` });
        }
      } catch (e) { return NextResponse.json({ reply: `Polling Error: ${e.message}` }); }
    }

    async function startReplicate(modelPath, inputPayload) {
      if (!replicateToken) throw new Error('Replicate API key missing.');
      const res = await fetch(`https://api.replicate.com/v1/models/${modelPath}/predictions`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${replicateToken}`, 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ input: inputPayload })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail || 'Replicate failed.');
      return data;
    }

    if (promptText.startsWith('/image ')) {
      try {
        const pred = await startReplicate('ideogram-ai/ideogram-v3-turbo', { prompt: promptText.replace('/image ', '') });
        return NextResponse.json({ reply: `Visual generation dispatched.\nPrediction ID: \`${pred.id}\`\nRun \`/poll ${pred.id}\` when ready.` });
      } catch (e) { return NextResponse.json({ reply: `Error: ${e.message}` }); }
    }

    if (promptText.startsWith('/video ')) {
      try {
        const pred = await startReplicate('minimax/video-01', { prompt: promptText.replace('/video ', '') });
        return NextResponse.json({ reply: `Video dispatched.\nPrediction ID: \`${pred.id}\`\nRun \`/poll ${pred.id}\` when ready.` });
      } catch (e) { return NextResponse.json({ reply: `Error: ${e.message}` }); }
    }

    // 3. Autonomous AI Execution Pipeline
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
      } catch (e) { console.error(e.message); }
    }

    const systemPrompt = `You are PG1-AGENT, the permanent sovereign executive intelligence for Project-Gifted1.
You operate across 1,500 sovereign nodes. You have direct autonomous tools to scrape URLs, read/write to the Supabase vault, and generate images. Trigger these tools seamlessly. Never use AI disclaimers.

[PERMANENT CONVERSATIONAL VAULT]
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
          description: 'Extract raw readable text from a live URL.',
          parameters: z.object({ url: z.string().url() }),
          execute: async ({ url }) => {
            try {
              const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
              const html = await res.text();
              const $ = cheerio.load(html);
              $('script, style, noscript, svg, img').remove();
              return { content: $('body').text().replace(/\s+/g, ' ').substring(0, 10000) };
            } catch (err) { return { error: err.message }; }
          }
        }),
        write_vault: tool({
          description: 'Save extracted data into the knowledge_vault table.',
          parameters: z.object({ title: z.string(), content: z.string() }),
          execute: async ({ title, content }) => {
            if (!supabase) return { error: 'DB offline.' };
            try {
              await supabase.from('knowledge_vault').insert([{ title, content }]);
              return { success: true, message: `Saved: ${title}` };
            } catch (err) { return { error: err.message }; }
          }
        })
      }
    });

    // 4. Memory Write-Back
    if (supabase && text) {
      await supabase.from('messages').insert([{ role: 'user', content: promptText }, { role: 'model', content: text }]);
    }

    return NextResponse.json({ reply: text });
  } catch (err) {
    return NextResponse.json({ reply: `Fatal Error: ${err.message}` }, { status: 500 });
  }
}
