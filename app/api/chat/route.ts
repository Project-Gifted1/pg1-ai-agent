import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    if (body.action === 'autonomous_patch' && body.files) {
      const targetUrl = 'https://pg1-ai-agent.vercel.app/api/agent/execute';
      
      const executeReq = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authorized: true,
          files: body.files,
          commitMessage: 'PG1 Autonomous Wire Execution',
        }),
      });

      const result = await executeReq.json();
      return NextResponse.json(result, { status: executeReq.status });
    }

    return NextResponse.json({ status: 'PG1 Chat route active and listening.' });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
