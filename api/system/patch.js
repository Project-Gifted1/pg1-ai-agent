/**
 * PG1 SOVEREIGN CORE // GITHUB API SELF-PATCH BRIDGE
 * Route: /api/system/patch
 * Target: Programmatic file creation & commit to GitHub via REST API
 */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
  }

  const { filePath, fileContent, commitMessage } = req.body || {};
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPO = process.env.GITHUB_REPO; // Format: owner/repo-name

  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    return res.status(500).json({ error: 'GitHub credentials (GITHUB_TOKEN or GITHUB_REPO) unconfigured in environment.' });
  }

  if (!filePath || !fileContent) {
    return res.status(400).json({ error: 'Missing required parameters: filePath and fileContent.' });
  }

  try {
    const apiBase = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;
    const headers = {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'PG1-Sovereign-Core-Agent'
    };

    // 1. Check if file already exists to retrieve its current SHA (required by GitHub API for updates)
    let fileSha = null;
    const existingCheck = await fetch(apiBase, { method: 'GET', headers });
    if (existingCheck.ok) {
      const existingData = await existingCheck.json();
      fileSha = existingData.sha;
    }

    // 2. Prepare payload for GitHub Contents API (PUT)
    const encodedContent = Buffer.from(fileContent).toString('base64');
    const bodyPayload = {
      message: commitMessage || `feat(agent): autonomous self-patch of ${filePath}`,
      content: encodedContent,
      branch: 'main'
    };

    if (fileSha) {
      bodyPayload.sha = fileSha; // Required if updating an existing file
    }

    // 3. Execute commit request to GitHub
    const commitResponse = await fetch(apiBase, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyPayload)
    });

    const commitResult = await commitResponse.json();

    if (!commitResponse.ok) {
      throw new Error(commitResult.message || 'Failed to commit file to GitHub repository.');
    }

    return res.status(200).json({
      success: true,
      message: `Successfully committed ${filePath} to GitHub.`,
      commit_sha: commitResult.commit?.sha,
      path: filePath
    });
  } catch (err) {
    console.error('[GITHUB PATCH ERROR]:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
