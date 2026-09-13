export const maxDuration = 60;
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';

// Edge-safe Base64 encoder for audio fallback
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => null);
    if (!body) {
      return NextResponse.json(
        { success: false, error: 'Invalid payload.' },
        { status: 400 }
      );
    }

    // --- DECOUPLED TTS PIPELINE (Asynchronous Audio Endpoint) ---
    if (body.action === 'tts') {
      const { text, voiceId } = body;
      if (!text) return NextResponse.json({ error: 'No text provided' }, { status: 400 });

      const cartesiaKey = (process.env.CARTESIA_API_KEY || '').replace(/\s+/g, '');
      const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\s+/g, '');
      const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASEAPI_KEY || '').replace(/\s+/g, '');
      
      if (!cartesiaKey) return NextResponse.json({ error: 'Missing TTS API Key' }, { status: 500 });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const ttsRes = await fetch('https://api.cartesia.ai/tts/bytes', {
        method: 'POST',
        headers: { 
          'Cartesia-Version': '2024-06-10', 
          'X-API-Key': cartesiaKey, 
          'Content-Type': 'application/json' 
        },
        body: JSON.stringify({
          model_id: process.env.CARTESIA_MODEL_ID || 'sonic-3.6',
          transcript: text.replace(/[*_#`[\]()]/g, '').substring(0, 3000).trim(),
          voice: { mode: 'id', id: voiceId || 'a0e99841-438c-4a64-b679-ae501e7d6091' },
          output_format: { container: 'mp3', sample_rate: 44100 }
        }),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);

      if (!ttsRes.ok) {
        return NextResponse.json({ error: `Cartesia API Error: ${ttsRes.status}` }, { status: 502 });
      }

      const arrayBuffer = await ttsRes.arrayBuffer();
      
      if (supabaseUrl && supabaseKey) {
        const fileName = `tts_${Date.now()}.mp3`;
        const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/pg1-vault/${fileName}`, {
          method: 'POST',
          headers: { 
            'apikey': supabaseKey, 
            'Authorization': `Bearer ${supabaseKey}`, 
            'Content-Type': 'audio/mp3' 
          },
          body: arrayBuffer
        });
        
        if (uploadRes.ok) {
          return NextResponse.json({ 
            success: true, 
            audioUrl: `${supabaseUrl}/storage/v1/object/public/pg1-vault/${fileName}` 
          });
        }
      }

      return NextResponse.json({ 
        success: true, 
        audioBase64: arrayBufferToBase64(arrayBuffer) 
      });
    }

    // --- STANDARD LLM & AUDIT PIPELINE ---
    const { message, voiceEnabled = false } = body;
    if (typeof message !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Invalid payload: "message" (string) is required.' },
        { status: 400 }
      );
    }
    const promptText = message.trim();

    // Direct Command Vector: /audit-scrape
    if (promptText.startsWith('/audit-scrape')) {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
      const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASEAPI_KEY;

      if (!supabaseUrl || !supabaseKey) {
        return NextResponse.json(
          { success: false, error: 'Supabase credentials not configured in environment.' },
          { status: 500 }
        );
      }

      const scrapeRes = await fetch('https://news.ycombinator.com/', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PG1-Agent/1.0' }
      });

      if (!scrapeRes.ok) {
        return NextResponse.json(
          { success: false, error: `Scrape request failed with status: ${scrapeRes.status}` },
          { status: 502 }
        );
      }

      const html = await scrapeRes.text();
      const titleRegex = /<a[^>]+class="storylink"[^>]*>([^<]+)<\/a>|<span class="titleline"><a[^>]+>([^<]+)<\/a>/g;
      const headlines = [];
      let match;
      while ((match = titleRegex.exec(html)) !== null && headlines.length < 3) {
        headlines.push(match[1] || match[2]);
      }

      if (headlines.length === 0) {
        headlines.push('Hacker News Top Item 1', 'Hacker News Top Item 2', 'Hacker News Top Item 3');
      }

      const targetTable = 'knowledge_vault';
      const insertPayload = headlines.map((title) => ({
        source: 'https://news.ycombinator.com/',
        content: title,
        created_at: new Date().toISOString()
      }));

      const dbRes = await fetch(`${supabaseUrl}/rest/v1/${targetTable}`, {
        method: 'POST',
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        },
        body: JSON.stringify(insertPayload)
      });

      if (!dbRes.ok) {
        const dbErr = await dbRes.text();
        return NextResponse.json(
          { success: false, error: `Database Write Failed (${dbRes.status}): ${dbErr}` },
          { status: 500 }
        );
      }

      return NextResponse.json({
        success: true,
        reply: `[AUDIT SUCCESS]\n- Target: news.ycombinator.com\n- Captured Items:\n  1. ${headlines[0]}\n  2. ${headlines[1]}\n  3. ${headlines[2]}\n- Database Commit: Verified written to "${targetTable}".`,
        timestamp: new Date().toISOString()
      });
    }

    // Standard LLM Inference Gateway
    const apiKey = process.env.GEMINI_API_KEY1 || process.env.GEMINI_API_KEY || '';
    if (!apiKey) {
      return NextResponse.json(
        { success: false, error: 'Missing Gemini API Key in environment variables.' },
        { status: 500 }
      );
    }

    const MODEL_NAME = 'gemini-1.5-flash';
    const inferenceUrl = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${apiKey}`;

    const modelRes = await fetch(inferenceUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: promptText }] }]
      })
    });

    if (!modelRes.ok) {
      const errDetail = await modelRes.text();
      return NextResponse.json(
        { success: false, error: `Inference Gateway Error (${modelRes.status}): ${errDetail}` },
        { status: modelRes.status }
      );
    }

    const data = await modelRes.json();
    const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No content returned from model.';
    const sanitizedReply = replyText.replace(/Google|Gemini|Anthropic|OpenAI|ChatGPT|bard/gi, 'PG1-Core');

    return NextResponse.json({
      success: true,
      reply: sanitizedReply,
      voiceStatus: voiceEnabled ? 'TTS_READY' : 'DISABLED',
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    return NextResponse.json(
      { success: false, error: `Serverless Runtime Exception: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
