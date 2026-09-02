import { Octokit } from "@octokit/rest";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,PATCH,DELETE,POST,PUT");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  try {
    const { action, filePath, fileContent, commitMessage, workflowFileName, branch = "main" } = req.body;

    const githubToken = process.env.GH_PAT || process.env.GITHUB_TOKEN;
    const githubOwner = process.env.GITHUB_OWNER || "Project-Gifted1";
    const githubRepo = process.env.GITHUB_REPO || "pg1-ai-agent";

    if (!githubToken) {
      console.error("[PG1 GitHub Bridge Error]: Authentication token missing.");
      return res.status(500).json({ error: "GitHub token missing from Vercel environment variables." });
    }

    const octokit = new Octokit({ auth: githubToken });

    if (action === "commit") {
      if (!filePath || !fileContent) {
        return res.status(400).json({ error: "filePath and fileContent are required." });
      }

      let sha;
      try {
        const existingFile = await octokit.rest.repos.getContent({
          owner: githubOwner,
          repo: githubRepo,
          path: filePath,
          ref: branch,
        });
        if (!Array.isArray(existingFile.data)) {
          sha = existingFile.data.sha;
        }
      } catch (err) {
        // File does not exist, proceed without SHA to create new file
        sha = undefined;
      }

      const commitResponse = await octokit.rest.repos.createOrUpdateFileContents({
        owner: githubOwner,
        repo: githubRepo,
        path: filePath,
        message: commitMessage || `Auto-commit via PG1-AGENT: update ${filePath}`,
        content: Buffer.from(fileContent).toString("base64"),
        branch: branch,
        sha: sha,
      });

      console.log(`[PG1 GitHub Bridge]: Successfully committed ${filePath}`);
      
      return res.status(200).json({
        success: true,
        message: `Successfully committed ${filePath} to branch ${branch}`,
        commitUrl: commitResponse.data.commit.html_url,
      });
    }

    if (action === "trigger_workflow") {
      if (!workflowFileName) {
        return res.status(400).json({ error: "workflowFileName is required (e.g. 'deploy.yml')." });
      }

      await octokit.rest.actions.createWorkflowDispatch({
        owner: githubOwner,
        repo: githubRepo,
        workflow_id: workflowFileName,
        ref: branch,
      });

      console.log(`[PG1 GitHub Bridge]: Triggered workflow ${workflowFileName}`);

      return res.status(200).json({
        success: true,
        message: `Triggered workflow ${workflowFileName} on branch ${branch}`,
      });
    }

    return res.status(400).json({ error: "Invalid action. Supported: 'commit', 'trigger_workflow'" });

  } catch (error) {
    console.error("[PG1 GitHub Bridge Error]:", error);
    return res.status(500).json({
      error: "GitHub Bridge Pipeline Error",
      details: error.message,
    });
  }
}
