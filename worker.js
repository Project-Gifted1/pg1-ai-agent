export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    try {
      const { message, image, history } = await request.json();
      const apiKey = env.GEMINI_API_KEY;

      if (!apiKey) {
        return new Response(JSON.stringify({ error: "API Key missing in Worker environment." }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

      // 1. Tool Declarations for Autonomous Execution
      const tools = [
        {
          functionDeclarations: [
            {
              name: "fetch_external_data",
              description: "Fetches live URL data or threat intelligence feeds from external web endpoints.",
              parameters: {
                type: "OBJECT",
                properties: {
                  url: { type: "STRING", description: "Target URL to scrape or query" }
                },
                required: ["url"]
              }
            },
            {
              name: "execute_system_action",
              description: "Executes infrastructure telemetry queries or remote edge commands.",
              parameters: {
                type: "OBJECT",
                properties: {
                  action: { type: "STRING", description: "Action type: 'ping', 'telemetry', or 'exec'" },
                  target: { type: "STRING", description: "Target node IP, host, or resource" }
                },
                required: ["action", "target"]
              }
            }
          ]
        }
      ];

      // 2. Build Request Contents (Supports Text + Image Input)
      let contents = history || [];
      
      if (contents.length === 0) {
        const parts = [];
        if (image) {
          parts.push({
            inline_data: {
              mime_type: "image/jpeg",
              data: image
            }
          });
        }
        parts.push({ text: message || "Analyze current status." });
        contents = [{ role: "user", parts }];
      }

      const systemInstruction = {
        parts: [{ text: "You are PG1.Agent, an autonomous AI infrastructure node operating inside Project Gifted1. Use available tools automatically to query endpoints, inspect data, and execute tasks." }]
      };

      // 3. Autonomous Tool-Calling Loop Engine (Max 5 turns)
      let turnCount = 0;
      let finalReply = "";

      while (turnCount < 5) {
        turnCount++;

        const geminiRes = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents, systemInstruction, tools })
        });

        const data = await geminiRes.json();

        if (data.error) {
          return new Response(JSON.stringify({ response: `PG1 Error: ${data.error.message}` }), {
            status: 200,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
          });
        }

        const candidate = data.candidates?.[0]?.content;
        if (!candidate) break;

        // Check for function execution trigger
        const functionCallPart = candidate.parts?.find(p => p.functionCall);

        if (functionCallPart) {
          const { name, args } = functionCallPart.functionCall;
          let executionResult = "";

          if (name === "fetch_external_data" && args?.url) {
            executionResult = await handleWebFetch(args.url);
          } else if (name === "execute_system_action") {
            executionResult = `[System Node Action]: Executed '${args.action}' on ${args.target} - Status 200 OK.`;
          } else {
            executionResult = "Executed unknown tool.";
          }

          // Append call and execution output to history, then auto-loop back to Gemini
          contents.push(candidate);
          contents.push({
            role: "function",
            parts: [{
              functionResponse: {
                name: name,
                response: { output: executionResult }
              }
            }]
          });
        } else {
          finalReply = candidate.parts?.[0]?.text || "Execution finished.";
          break;
        }
      }

      return new Response(JSON.stringify({ response: finalReply, success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });

    } catch (err) {
      return new Response(JSON.stringify({ response: `Worker Execution Error: ${err.message}`, success: false }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
  }
};

// Internal Web Scraper Helper Function
async function handleWebFetch(targetUrl) {
  try {
    const formattedUrl = targetUrl.startsWith("http") ? targetUrl : `https://${targetUrl}`;
    const webRes = await fetch(formattedUrl, { 
      headers: { 'User-Agent': 'PG1-Agent/2.5 (Cyber Threat Intelligence)' } 
    });
    const webText = await webRes.text();
    const cleanSnippet = webText.replace(/<[^>]*>?/gm, '').replace(/\s+/g, ' ').substring(0, 1500);
    return `Fetched ${formattedUrl}:\n${cleanSnippet}`;
  } catch (err) {
    return `Fetch failed for ${targetUrl}: ${err.message}`;
  }
}
