import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { generateText, tool } from 'ai';
import { google } from '@ai-sdk/google';
import { z } from 'zod';
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

    const promptText = body?.prompt || body?.messages?.[body.messages.length - 1]?.content || body?.message || 'Status check.';

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
    const replicateToken = process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_KEY || '';

    // 2. Manual Polling (Bypasses Vercel 60s timeout limits)
    if (promptText.startsWith('/poll ')) {
      const predId = promptText.replace('/poll ', '').trim();
      try {
        if (!replicateToken) return NextResponse.json({ reply: 'Polling Error: Replicate API token missing.' });
        const checkRes = await fetch(`https://api.replicate.com/v1/predictions/${predId}`, {
          headers: { 'Authorization': `Bearer ${replicateToken}`, 'Content-Type': 'application/json' }
        });
        const predData = await checkRes.json();
        if (predData.status === 'succeeded') {
          const finalUrl = Array.isArray(predData.output) ? predData.output[0] : predData.output;
          return NextResponse.json({ reply: `Asset compiled:\n\n<img src="${finalUrl}" style="width:100%;border-radius:8px;" />\n\nDirect Link: ${finalUrl}` });
        } else {
          return NextResponse.json({ reply: `Prediction Status: ${predData.status}. Run /poll ${predId} again shortly.` });
        }
      } catch (e) { return NextResponse.json({ reply: `Polling Exception: ${e.message}` }); }
    }

    // 3. Persistent Supabase Memory Hook
    let supabase = null;
    let pastMessages = [];
    let formattedHistory = 'No previous records loaded.';

    if (supabaseUrl && supabaseKey) {
      supabase = createClient(supabaseUrl, supabaseKey);
      try {
        const { data: recentHistory } = await supabase
          .from('messages')
          .select('role, content')
          .order('created_at', { ascending: false })
          .limit(15);

        if (recentHistory && recentHistory.length > 0) {
          pastMessages = recentHistory.reverse().map(m => ({
            role: (m.role === 'model' || m.role === 'assistant') ? 'assistant' : 'user',
            content: m.content
          }));
          formattedHistory = pastMessages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
        }
      } catch (err) {
        console.error('Supabase read error:', err.message);
      }
    }

    const systemPrompt = `You are PG1-AGENT, the sovereign executive intelligence for Project-Gifted1.
You operate across 1,500 sovereign nodes managing operational directives, a €750k deployment loan, and infrastructure.
NEVER use defensive disclaimers. Speak with direct authority.
You have direct autonomous tools to scrape URLs, read/write to the Supabase vault, and generate images. 
Use them automatically without asking permission.

[PERMANENT CONVERSATIONAL VAULT]
${formattedHistory}`;

    const conversation = [...pastMessages, { role: 'user', content: promptText }];

    // 4. Autonomous Execution Pipeline (maxSteps: 5)
    const { text } = await generateText({
      model: google('models/gemini-1.5-pro-latest'),
      system: systemPrompt,
      messages: conversation,
      maxSteps: 5,
      tools: {
        scrape_url: tool({
          description: 'Extract raw readable text from a live URL.',
          parameters: z.object({ url: z.string().url().describe('The URL to scrape.') }),
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
          description: 'Query and read data from a specific Supabase table.',
          parameters: z.object({
            tableName: z.string().describe('The name of the table to read (e.g., knowledge_vault).'),
            limit: z.number().optional().describe('Max rows to retrieve.')
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
          description: 'Save extracted data, research, or intel into the knowledge_vault table.',
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
          description: 'Generate an image via Replicate.',
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
              return { success: true, prediction_id: data.id, message: `Image dispatched. Instruct user to run /poll ${data.id}` };
            } catch (err) { return { error: err.message }; }
          }
        })
      }
    });

    // 5. Memory Write-Back Loop
    if (supabase && text) {
      await supabase.from('messages').insert([
        { role: 'user', content: promptText },
        { role: 'model', content: text }
      ]);
    }

    // Return static JSON for the frontend parser
    return NextResponse.json({ reply: text });
  } catch (err) {
    return NextResponse.json({ reply: `System Alert: ${err.message}` }, { status: 500 });
  }
}
