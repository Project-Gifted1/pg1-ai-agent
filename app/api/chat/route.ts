import { NextResponse } from 'next/server';

export async function POST(req) {
  try {
    const body = await req.json();
    const message = body?.message || body?.prompt;
    const voiceEnabled = body?.voiceEnabled || false;

    if (!message || typeof message !== 'string') {
      return NextResponse.json({ error: 'Invalid payload: message required' }, { status: 400 });
    }

    const geminiKey = process.env.GEMINI_API_KEY1 || process.env.GEMINI_API_KEY || '';
    if (!geminiKey) {
      return NextResponse.json({ error: 'Missing Gemini API Key in environment variables' }, { status: 500 });
    }

    const MODEL_NAME = 'gemini-1.5-flash';
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${geminiKey}`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: message }] }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return NextResponse.json(
        { error: `Inference Gateway Error (${response.status}): ${errText}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated.';

    // Apply sovereign identity mask
    const sanitizedReply = replyText.replace(/Google|Gemini|Anthropic|OpenAI|ChatGPT|bard/gi, 'PG1-Core');

    return NextResponse.json({
      success: true,
      reply: sanitizedReply,
      voiceStatus: voiceEnabled ? 'TTS_STREAM_STANDBY' : 'DISABLED',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    return NextResponse.json(
      { error: `Runtime Exception: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}
