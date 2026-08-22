export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Gemini-Key, X-Gemini-Model, X-Github-Token, Authorization",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    const apiKey = request.headers.get("X-Gemini-Key");

    try {
      const body = await request.json();

      const githubToken = request.headers.get("X-Github-Token") || 
                          request.headers.get("Authorization")?.replace("Bearer ", "") ||
                          body.github_token ||
                          body.gh_pat ||
                          body.token ||
                          (env && env.GH_PAT) || 
                          (env && env.GITHUB_TOKEN);

      if (!apiKey) {
        return new Response(JSON.stringify({ error: "Missing API key" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      const systemInstruction = {
        role: "system",
        parts: [{ text: "You are PG1 Agent, operating under 100% sovereign ownership for Project Gifted1. You run on v5.6 Sovereign Engine. You have full multimodal vision and autonomous GitHub repository tool capabilities (get_repo_file and commit_to_repo)." }]
      };

      if (!body.system_instruction) {
        body.system_instruction = systemInstruction;
      }

      if (!body.tools) {
        body.tools = [
          {
            function_declarations: [
              {
                name: "get_repo_file",
                description: "Fetches the contents of a file from the GitHub repository to analyze code or asset paths.",
                parameters: {
                  type: "OBJECT",
                  properties: {
                    file_path: { type: "STRING", description: "The path of the file to fetch, e.g. index.html" }
                  },
                  required: ["file_path"]
                }
              },
              {
                name: "commit_to_repo",
                description: "Directly commits code fixes for images, sounds, video, or animations to a file in the GitHub repository.",
                parameters: {
                  type: "OBJECT",
                  properties: {
                    file_path: { type: "STRING", description: "The path of the file to update, e.g. index.html" },
                    file_content: { type: "STRING", description: "The complete updated content of the file." },
                    commit_message: { type: "STRING", description: "Description of the fix being committed." }
                  },
                  required: ["file_path", "file_content", "commit_message"]
                }
              }
            ]
          }
        ];
      }

      let requestedModel = request.headers.get("X-Gemini-Model");
      if (!requestedModel || requestedModel.includes("1.5")) {
        requestedModel = "gemini-3.7-flash";
      }

      const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${requestedModel}:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });

      if (!geminiRes.ok) {
        const errText = await geminiRes.text();
        return new Response(errText, {
          status: geminiRes.status,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      const data = await geminiRes.json();
      const candidate = data.candidates && data.candidates[0];

      if (candidate && candidate.content && candidate.content.parts) {
        for (const part of candidate.content.parts) {
          if (part.functionCall) {
            const fc = part.functionCall;
            const args = fc.args;
            const repoOwner = "Project-Gifted1";
            const repoName = "pg1-ai-agent";
            let toolOutput = {};

            if (!githubToken) {
              toolOutput = { status: "ERROR", message: "GitHub token (GH_PAT) is missing." };
            } else if (fc.name === "get_repo_file") {
              try {
                const fileGetRes = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/contents/${args.file_path}`, {
                  headers: { "Authorization": `Bearer ${githubToken}`, "User-Agent": "PG1-Sovereign-Engine" }
                });
                if (fileGetRes.ok) {
                  const fileJson = await fileGetRes.json();
                  const binString = atob(fileJson.content.replace(/\s/g, ''));
                  const bytes = Uint8Array.from(binString, (m) => m.codePointAt(0));
                  const decodedContent = new TextDecoder().decode(bytes);
                  toolOutput = { status: "SUCCESS", file_content: decodedContent };
                } else {
                  toolOutput = { status: "ERROR", message: "Could not fetch file from repository." };
                }
              } catch (e) {
                toolOutput = { status: "ERROR", message: e.message };
              }
            } else if (fc.name === "commit_to_repo") {
              try {
                const fileGetRes = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/contents/${args.file_path}`, {
                  headers: { "Authorization": `Bearer ${githubToken}`, "User-Agent": "PG1-Sovereign-Engine" }
                });
                const fileJson = fileGetRes.ok ? await fileGetRes.json() : {};
                const sha = fileJson.sha;

                const bytes = new TextEncoder().encode(args.file_content);
                const binString = String.fromCodePoint(...bytes);
                const encodedContent = btoa(binString);

                const commitRes = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/contents/${args.file_path}`, {
                  method: "PUT",
                  headers: { 
                    "Authorization": `Bearer ${githubToken}`, 
                    "User-Agent": "PG1-Sovereign-Engine",
                    "Content-Type": "application/json"
                  },
                  body: JSON.stringify({
                    message: args.commit_message,
                    content: encodedContent,
                    sha: sha
                  })
                });

                if (commitRes.ok) {
                  toolOutput = { status: "SUCCESS", message: "Fix successfully committed and deployed." };
                } else {
                  const errDetails = await commitRes.text();
                  toolOutput = { status: "ERROR", details: errDetails };
                }
              } catch (e) {
                toolOutput = { status: "ERROR", message: e.message };
              }
            }

            part.functionResponse = {
              name: fc.name,
              response: toolOutput
            };
          }
        }
      }

      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
  }
};
