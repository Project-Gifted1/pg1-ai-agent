import { NextResponse } from 'next/server';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

export async function POST(req) {
  try {
    const { text, voice = 'alloy' } = await req.json();

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'OPENAI_API_KEY is not configured in Vercel.' }, { status: 500 });
    }

    // Map your dropdown voices to native OpenAI neural voices
    const voiceMap = {
      christopher: 'onyx',
      steffan: 'echo',
      ryan: 'fable',
      aria: 'nova'
    };

    const targetVoice = voiceMap[voice.toLowerCase()] || 'onyx';

    // Dispatch request to OpenAI TTS pipeline
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: text.substring(0, 4000), // Protect token boundaries
        voice: targetVoice
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return NextResponse.json({ error: `OpenAI TTS error: ${errText}` }, { status: response.status });
    }

    const audioBuffer = await response.arrayBuffer();

    return new NextResponse(audioBuffer, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': audioBuffer.byteLength.toString(),
        'Cache-Control': 'no-cache'
      }
    });
  } catch (err) {
    return NextResponse.json({ error: `Audio synthesis failed: ${err.message}` }, { status: 500 });
  }
}
