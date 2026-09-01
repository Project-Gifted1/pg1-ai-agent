import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { messages, executeAutonomousPatch } = await req.json();

    const lastMessage = messages[messages.length - 1]?.content || '';

    // AUTONOMOUS EXECUTION TRIGGER:
    // If the boss authorizes an execution in the chat, run the bridge internally
    if (executeAutonomousPatch && executeAutonomousPatch.files) {
      const bridgeRes = await fetch(new URL('/api/agent/execute', req.url).toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authorized: true,
          commitMessage: executeAutonomousPatch.commitMessage || 'autonomous: patch applied via command center',
          files: executeAutonomousPatch.files,
        }),
      });

      const bridgeData = await bridgeRes.json();
      return NextResponse.json({
        role: 'assistant',
        content: bridgeData.success
          ? `✅ Autonomous patch executed successfully. Commit SHA: ${bridgeData.results?.[0]?.commitSha || 'confirmed'}. Vercel build triggered.`
          : `❌ Autonomous execution failed: ${bridgeData.error}`,
        executionResult: bridgeData,
      });
    }

    // GEMINI CORE CHAT COMPLETION
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'GEMINI_API_KEY is not configured.' }, { status: 500 });
    }

    const geminiPayload = {
      contents: messages.map((m: any) => ({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.content }],
      })),
      systemInstruction: {
        parts: [
          {
            text: 'You are PG1-AGENT, the core sovereign intelligence of Project-Gifted1. You speak with high authority, precision, and loyalty to the Boss. You operate autonomously upon command.',
          },
        ],
      },
    };

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiPayload),
      }
    );

    const data = await res.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || 'PG1 intelligence online.';

    return NextResponse.json({ role: 'assistant', content: reply });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Chat route execution error.' }, { status: 500 });
  }
}
