import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function getReplicateToken(): string | null {
  const token =
    process.env.REPLICATE_API_TOKEN ||
    process.env.REPLICATE_API_KEY ||
    process.env.REPLICATE_TOKEN ||
    '';
  const clean = token.trim().replace(/^["']|["']$/g, '');
  return clean.length > 0 ? clean : null;
}

export async function POST(req: NextRequest) {
  try {
    const replicateToken = getReplicateToken();
    if (!replicateToken) {
      return NextResponse.json(
        { error: 'Replicate API token is missing in Vercel environment variables.' },
        { status: 500 }
      );
    }

    const { prompt, aspect_ratio = '16:9' } = await req.json();

    if (!prompt) {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });
    }

    const response = await fetch('https://api.replicate.com/v1/models/ideogram-ai/ideogram-v3-turbo/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${replicateToken}`,
        'Content-Type': 'application/json',
        'Prefer': 'wait=60',
      },
      body: JSON.stringify({
        input: {
          prompt,
          aspect_ratio,
          magic_prompt_option: 'Auto',
        },
      }),
    });

    let prediction = await response.json();

    if (!response.ok || prediction.error) {
      return NextResponse.json(
        { error: prediction.error || prediction.detail || 'Replicate generation failed' },
        { status: response.status || 500 }
      );
    }

    while (prediction.status !== 'succeeded' && prediction.status !== 'failed' && prediction.status !== 'canceled') {
      await new Promise((r) => setTimeout(r, 2000));
      const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
        headers: {
          'Authorization': `Bearer ${replicateToken}`,
          'Content-Type': 'application/json',
        },
      });
      prediction = await pollRes.json();
    }

    if (prediction.status === 'failed') {
      return NextResponse.json({ error: prediction.error || 'Image generation failed.' }, { status: 500 });
    }

    const imageUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;

    return NextResponse.json({ success: true, imageUrl, prompt });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
