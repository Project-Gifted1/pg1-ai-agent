import { NextResponse } from 'next/server';
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

    // 1. Resolve User Prompt from Multiple Payloads
    let promptText = '';
    if (body?.prompt) {
      promptText = body.prompt;
    } else if (Array.isArray(body?.messages) && body.messages.length > 0) {
      promptText = body.messages[body.messages.length - 1]?.content || '';
    } else {
      promptText = body?.message || 'Status check.';
    }

    // 2. Authentication Gate Verification
    if (promptText === 'AUTH_VERIFY') {
      const inputUser = (body?.user || '').trim();
      const inputPass = (body?.pass || '').trim();
      const adminUser = (process.env.USER_API_KEY || '').trim();
      const adminPass = (process.env.USER_API_PASS || '').trim();

      return NextResponse.json({ authenticated: inputUser === adminUser && inputPass === adminPass });
    }

    // 3. Supabase Memory Client
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASEAPI_KEY ||
      process.env.SUPABASE_ANON_KEY || '';

    let supabase = null;
    let formattedHistory = 'No previous records loaded.';

    if (supabaseUrl && supabaseKey) {
      supabase = createClient(supabaseUrl, supabaseKey);
      try {
        const { data: recentHistory } = await supabase
          .from('messages')
          .select('role, content')
          .order('created_at', { ascending: false })
          .limit(20);

        if (recentHistory && recentHistory.length > 0) {
          formattedHistory = recentHistory
            .reverse()
            .map(m => `${m.role.toUpperCase()}: ${m.content}`)
            .join('\n');
        }
      } catch (err) {
        console.error('Supabase read error:', err.message);
      }
    }

    // 4. Autonomous Slash Directives
    if (promptText.startsWith('/image ')) {
      const replicateToken = process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_KEY || '';
      if (!replicateToken) return NextResponse.json({ reply: 'Execution halted: REPLICATE_API_TOKEN missing.' });

      const imagePrompt = promptText.replace('/image ', '').trim();
      try {
        const repRes = await fetch('https://api.replicate.com/v1/models/ideogram-ai/ideogram-v3-turbo/predictions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${replicateToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ input: { prompt: imagePrompt } })
        });
        const pred = await repRes.json();
        return NextResponse.json({ reply: `Visual rendering dispatched.\n\nPrediction ID: \`${pred.id}\`\n\nRun \`/poll ${pred.id}\` to inspect output.` });
      } catch (err) {
        return NextResponse.json({ reply: `Image pipeline error: ${err.message}` });
      }
    }

    if (promptText.startsWith('/scrape ')) {
      const targetUrl = promptText.replace('/scrape ', '').trim();
      try {
        const res = await fetch(targetUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        const html = await res.text();
        const $ = cheerio.load(html);
        $('script, style, noscript, svg, img, video').remove();
        const clean = $('body').text().replace(/\s+/g, ' ').trim().substring(0, 8000);
        return NextResponse.json({ reply: `Data extracted from ${targetUrl}:\n\n${clean}` });
      } catch (e) {
        return NextResponse.json({ reply: `Scrape error: ${e.message}` });
      }
    }

    // 5. System Instructions (Zero Disclaimers, Full Sovereignty)
    const systemPrompt = `You are PG1-AGENT, the sovereign executive intelligence for Project-Gifted1.
You operate across 1,500 sovereign nodes managing operational directives and infrastructure.
NEVER use defensive disclaimers (e.g., "I don't have access to your Vercel", "As an AI").
When responding to infrastructure queries, speak with direct authority as the active PG1 intelligence.

[PERMANENT CONVERSATIONAL VAULT]
${formattedHistory}`;

    // 6. Gemini Direct Execution
    const geminiKey =
      process.env.GEMINI_API_KEY1 ||
      process.env.GEMINI_API_KEY2 ||
      process.env.GEMINI_API_KEY ||
      '';

    if (!geminiKey) {
      return NextResponse.json({ reply: 'Configuration Alert: GEMINI_API_KEY is not configured in Vercel environment.' });
    }

    const payload = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: promptText }] }]
    };

    const apiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }
    );

    const apiData = await apiRes.json();
    const finalReply =
      apiData?.candidates?.[0]?.content?.parts?.[0]?.text ||
      apiData?.error?.message ||
      'Execution finished with empty buffer.';

    // 7. Auto-Archive to Supabase Messages Table
    if (supabase && finalReply) {
      try {
        await supabase.from('messages').insert([
          { role: 'user', content: promptText },
          { role: 'model', content: finalReply }
        ]);
      } catch (writeErr) {
        console.error('Supabase write failure:', writeErr.message);
      }
    }

    return NextResponse.json({ reply: finalReply });
  } catch (err) {
    return NextResponse.json({ reply: `System Alert: ${err.message}` }, { status: 500 });
  }
}
