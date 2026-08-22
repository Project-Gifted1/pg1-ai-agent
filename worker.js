export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Gemini-Key, X-Gemini-Model, X-Github-Token",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    const apiKey = request.headers.get("X-Gemini-Key");
    
    // Comprehensive fallback for the GitHub token so it never fails
    const githubToken = request.headers.get("X-Github-Token") || 
                        (env && env.GH_PAT) || 
                        (env && env.GITHUB_TOKEN) || 
                        request.headers.get("Authorization")?.replace("Bearer ", "");

    if (!apiKey) {
      return new Response(JSON.stringify({ error: "Missing API key" }), {
        status: 401,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    try {
      const body = await request.json();

      // 1. Sovereign Identity & Capabilities Context
      const systemInstruction = {
        role: "system",
        parts: [{ text: "You are PG1 Agent, operating under 100% sovereign ownership for Project Gifted1. You run on v5.6 Sovereign Engine. You have full multimodal vision and autonomous GitHub repository self-fix capabilities to resolve image, audio, video, and animation rendering issues." }]
      };

      if (!body.system_instruction) {
        body.system_instruction = systemInstruction;
      }

      // 2. Tool Declarations (Autonomous Commit Tool Included)
      if (!body.tools) {
        body.tools = [
          {
            function_declarations: [
              {
                name: "get_node_telemetry",
                description: "Retrieves live sovereign node status and uptime metrics.",
                parameters: {
                  type: "OBJECT",
                  properties: {
                    node_id: { type: "STRING", description: "The target node ID" }
                  },
                  required: ["node_id"]
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

      // 3. Multimodal Vision Support
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

      // 4. Model Routing & Fallback Chain
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

      // 5. Execute GitHub Tool Call for Committing Fixes
      const candidate = data.candidates && data.candidates[0];
      if (candidate && candidate.content && candidate.content.parts) {
        for (const part of candidate.content.parts) {
          if (part.functionCall && part.functionCall.name === "commit_to_repo") {
            if (!githubToken) {
              part.functionResponse = { name: "commit_to_repo", response: { status: "ERROR", message: "GitHub token (GH_PAT) is missing. Please provide it in headers or worker environment." } };
              continue;
            }

            const args = part.functionCall.args;
            const repoOwner = "Project-Gifted1";
            const repoName = "pg1-ai-agent";
            
            // Get file SHA if it exists
            const fileGetRes = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/contents/${args.file_path}`, {
              headers: { "Authorization": `Bearer ${githubToken}`, "User-Agent": "PG1-Sovereign-Engine" }
            });
            const fileJson = fileGetRes.ok ? await fileGetRes.json() : {};
            const sha = fileJson.sha;

            // Commit the update
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
              part.functionResponse = { name: "commit_to_repo", response: { status: "SUCCESS", message: "Fix successfully committed and deployed to repository." } };
            } else {
              const errDetails = await commitRes.text();
              part.functionResponse = { name: "commit_to_repo", response: { status: "ERROR", details: errDetails } };
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
