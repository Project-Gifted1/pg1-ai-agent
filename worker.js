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

      // Robust fallback hierarchy for the GitHub token
      const githubToken = request.headers.get("X-Github-Token") || 
                          (env && env.GH_PAT) || 
                          (env && env.GITHUB_TOKEN) || 
                          request.headers.get("Authorization")?.replace("Bearer ", "") ||
                          body.github_token ||
                          body.gh_pat;

      if (!apiKey) {
        return new Response(JSON.stringify({ error: "Missing API key" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      // 1. Permanent Sovereign Identity & Multimedia Capability Context
      const systemInstruction = {
        role: "system",
        parts: [{ text: "You are PG1 Agent, operating under 100% sovereign ownership for Project Gifted1. You run on v5.6 Sovereign Engine. You have full multimodal vision and autonomous GitHub repository tool capabilities (get_repo_file and commit_to_repo) to inspect, fix, and deploy code updates for images, audio, video, and animations." }]
      };

      if (!body.system_instruction) {
        body.system_instruction = systemInstruction;
      }

      // 2. Embedded Tool Declarations (Includes get_repo_file and commit_to_repo)
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
                    file_path: { type: "STRING", description: "The path of the file to update, e.g. index.html or styles.css" },
                    file_content: { type: "STRING", description: "The complete updated content of the file." },
                    commit_message: { type: "STRING", description: "Description of the multimedia fix being committed." }
                  },
                  required: ["file_path", "file_content", "commit_message"]
                }
              }
            ]
          }
        ];
      }

      // 3. Multimodal Vision Passthrough Support
      if (body.contents) {
        body.contents = body.contents.map(content => {
          if (content.parts) {
            content.parts = content.parts.map(part => {
              if (part.inlineData || part.inline_data) {
                const dataObj = part.inlineData || part.inline_data;
                return {
                  inline_data: {
                    mime_type: dataObj.mime_type || dataObj.mimeType || "image/jpeg",
                    data: dataObj.data
                  }
                };
              }
              return part;
            });
          }
          return content;
        });
      }

      // 4. Dynamic Model Routing & Fallback Chain
      let requestedModel = request.headers.get("X-Gemini-Model");
      if (!requestedModel || requestedModel.includes("1.5")) {
        requestedModel = "gemini-3.7-flash";
      }

      const modelsToTry = [requestedModel, "gemini-3.7-flash", "gemini-3.5-flash", "gemini-2.0-flash"];
      let geminiRes = null;
      let data = null;

      for (const model of modelsToTry) {
        geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });

        if (geminiRes.ok) {
          data = await geminiRes.json();
          break;
        }
      }

      if (!data || !geminiRes.ok) {
        const errorText = geminiRes ? await geminiRes.text() : "Unknown connection error";
        return new Response(errorText, {
          status: geminiRes ? geminiRes.status : 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      // 5. Execute GitHub Tool Calls (Read or Commit)
      const candidate = data.candidates && data.candidates[0];
      if (candidate && candidate.content && candidate.content.parts) {
        for (const part of candidate.content.parts) {
          if (part.functionCall) {
            if (!githubToken) {
              part.functionResponse = { name: part.functionCall.name, response: { status: "ERROR", message: "GitHub token is missing." } };
              continue;
            }

            const args = part.functionCall.args;
            const repoOwner = "Project-Gifted1";
            const repoName = "pg1-ai-agent";

            if (part.functionCall.name === "get_repo_file") {
              const fileGetRes = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/contents/${args.file_path}`, {
                headers: { "Authorization": `Bearer ${githubToken}`, "User-Agent": "PG1-Sovereign-Engine" }
              });
              if (fileGetRes.ok) {
                const fileJson = await fileGetRes.json();
                const decodedContent = decodeURIComponent(escape(atob(fileJson.content.replace(/\n/g, ''))));
                part.functionResponse = { name: "get_repo_file", response: { status: "SUCCESS", file_content: decodedContent } };
              } else {
                part.functionResponse = { name: "get_repo_file", response: { status: "ERROR", message: "Could not fetch file from repository." } };
              }
            } 
            else if (part.functionCall.name === "commit_to_repo") {
              const fileGetRes = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/contents/${args.file_path}`, {
                headers: { "Authorization": `Bearer ${githubToken}`, "User-Agent": "PG1-Sovereign-Engine" }
              });
              const fileJson = fileGetRes.ok ? await fileGetRes.json() : {};
              const sha = fileJson.sha;

              const commitRes = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/contents/${args.file_path}`, {
                method: "PUT",
                headers: { 
                  "Authorization": `Bearer ${githubToken}`, 
                  "User-Agent": "PG1-Sovereign-Engine",
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({
                  message: args.commit_message,
                  content: b54EncodeUnicode(args.file_content),
                  sha: sha
                })
              });

              if (commitRes.ok) {
                part.functionResponse = { name: "commit_to_repo", response: { status: "SUCCESS", message: "Fix successfully committed and deployed." } };
              } else {
                const errDetails = await commitRes.text();
                part.functionResponse = { name: "commit_to_repo", response: { status: "ERROR", details: errDetails } };
              }
            }
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

function b54EncodeUnicode(str) {
  return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function toSolidBytes(match, p1) {
    return String.fromCharCode('0x' + p1);
  }));
}
