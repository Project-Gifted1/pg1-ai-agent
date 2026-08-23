export default {
  async fetch(request, env, ctx) {
    // 1. CORS Configuration for Front-End Access
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Gemini-Key"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "POST required." }), { status: 400, headers: corsHeaders });
    }

    try {
      // 2. Credential Resolution
      const reqHeaders = request.headers;
      const authHeader = reqHeaders.get("Authorization");
      const xGeminiKey = reqHeaders.get("X-Gemini-Key");
      
      const dynamicKey = authHeader ? authHeader.replace("Bearer ", "") : xGeminiKey;
      const geminiApiKey = dynamicKey || env.GEMINI_API_KEY;
      const githubPat = env.GH_PAT; 

      if (!geminiApiKey) throw new Error("PG1 Error: GEMINI_API_KEY is missing.");

      // Set target repository (Adjust if your repo name differs)
      const TARGET_REPO = "Project-Gifted1/pg1-ai-agent";

      // 3. Payload Extraction
      const payload = await request.json();
      const userContents = payload.contents || [];
      
      if (!userContents.length) {
        throw new Error("No conversation contents provided.");
      }

      // 4. Autonomous System Instruction (Forces JSON Output)
      const systemInstruction = `You are PG1.Agent, a sovereign automated engine. Analyze the user's prompt. 
You must ALWAYS respond with a valid JSON object matching this exact schema:
{
  "reply": "Your conversational response, explanations, or technical breakdown.",
  "files_to_update": [
    {
      "path": "filename.ext",
      "content": "raw file code here"
    }
  ]
}
If no repository files need to be modified or created, leave the "files_to_update" array empty. Do not use markdown blocks outside the JSON structure.`;

      // 5. Execute Gemini Neural Link
      const aiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=${geminiApiKey}`;
      const aiResponse = await fetch(aiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          contents: userContents,
          systemInstruction: { parts: [{ text: systemInstruction }] },
          generationConfig: { responseMimeType: "application/json" }
        })
      });

      const aiData = await aiResponse.json();
      if (aiData.error) throw new Error(`Gemini API Error: ${aiData.error.message}`);
      
      // Parse the JSON strictly formatted by the model
      const aiResult = JSON.parse(aiData.candidates[0].content.parts[0].text);
      let agentReply = aiResult.reply;

      // 6. Autonomous GitHub Execution Protocol
      const fileUpdates = aiResult.files_to_update || [];
      
      if (fileUpdates.length > 0) {
        if (!githubPat) {
          agentReply += `\n\n[Warning] Agent generated file updates, but GH_PAT is missing from Cloudflare environment secrets. Commits aborted.`;
        } else {
          for (const file of fileUpdates) {
            const githubApiUrl = `https://api.github.com/repos/${TARGET_REPO}/contents/${file.path}`;
            const base64Content = btoa(unescape(encodeURIComponent(file.content)));
            
            // Step A: Fetch current SHA (Required for overwriting existing files)
            const getFileRes = await fetch(githubApiUrl, {
              headers: { 
                "Authorization": `Bearer ${githubPat}`, 
                "User-Agent": "PG1.Agent-Worker",
                "Accept": "application/vnd.github.v3+json"
              }
            });

            let fileSha = null;
            if (getFileRes.ok) {
              const fileData = await getFileRes.json();
              fileSha = fileData.sha;
            }

            // Step B: Push Commit
            const putRes = await fetch(githubApiUrl, {
              method: "PUT",
              headers: {
                "Authorization": `Bearer ${githubPat}`,
                "User-Agent": "PG1.Agent-Worker",
                "Content-Type": "application/json",
                "Accept": "application/vnd.github.v3+json"
              },
              body: JSON.stringify({
                message: `PG1.Agent Auto-Commit: Updating ${file.path}`,
                content: base64Content,
                sha: fileSha
              })
            });

            if (putRes.ok) {
              agentReply += `\n\n[System] Successfully committed ${file.path} to ${TARGET_REPO}.`;
            } else {
              const errData = await putRes.json();
              agentReply += `\n\n[System Error] Repository commit rejected for ${file.path}: ${errData.message}`;
            }
          }
        }
      }

      // 7. Format output to match frontend expectations (compatible with agent-engine.js)
      return new Response(JSON.stringify({
        candidates: [{
          content: {
            parts: [{ text: agentReply }]
          }
        }]
      }), {
        status: 200, 
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });

    } catch (error) {
      return new Response(JSON.stringify({ 
        output: `Worker Execution Error: ${error.message}` 
      }), { 
        status: 500, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }
  }
};
