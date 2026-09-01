import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

interface FileUpdate {
  path: string;
  content: string;
}

export async function POST(req: NextRequest) {
  try {
    const { files, commitMessage, authorized } = await req.json();

    if (!authorized) {
      return NextResponse.json(
        { error: 'Autonomous execution denied: Boss consent required.' },
        { status: 403 }
      );
    }

    if (!files || !Array.isArray(files) || files.length === 0) {
      return NextResponse.json({ error: 'No files provided for commit.' }, { status: 400 });
    }

    const githubToken = process.env.GITHUB_TOKEN;
    const githubOwner = process.env.GITHUB_OWNER;
    const githubRepo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || 'main';

    if (!githubToken || !githubOwner || !githubRepo) {
      return NextResponse.json(
        { error: 'GitHub credentials (GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO) missing in Vercel environment.' },
        { status: 500 }
      );
    }

    const headers = {
      'Authorization': `Bearer ${githubToken.trim()}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'PG1-Autonomous-Agent',
    };

    const results = [];

    for (const file of files as FileUpdate[]) {
      let fileSha: string | undefined;
      const getFileRes = await fetch(
        `https://api.github.com/repos/${githubOwner}/${githubRepo}/contents/${file.path}?ref=${branch}`,
        { headers }
      );

      if (getFileRes.ok) {
        const fileData = await getFileRes.json();
        fileSha = fileData.sha;
      }

      const contentEncoded = Buffer.from(file.content).toString('base64');
      const putRes = await fetch(
        `https://api.github.com/repos/${githubOwner}/${githubRepo}/contents/${file.path}`,
        {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            message: commitMessage || `pg1-agent: autonomous patch for ${file.path}`,
            content: contentEncoded,
            branch: branch,
            ...(fileSha ? { sha: fileSha } : {}),
          }),
        }
      );

      const putData = await putRes.json();

      if (!putRes.ok) {
        throw new Error(`Failed to commit ${file.path}: ${putData.message || 'Unknown error'}`);
      }

      results.push({ path: file.path, success: true, commitSha: putData.commit?.sha });
    }

    return NextResponse.json({
      success: true,
      message: `Successfully executed autonomous patch across ${results.length} file(s).`,
      results,
    });
  } catch (error: any) {
    console.error('[PG1-AGENT] Execution Bridge Error:', error);
    return NextResponse.json(
      { error: error.message || 'Autonomous execution failed.' },
      { status: 500 }
    );
  }
}
