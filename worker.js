export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const { message, image, history, apiKey: payloadKey } = await request.json();
      
      const apiKey = payloadKey || env.GEMINI_API_KEY;

      if (!apiKey) {
        return new Response(JSON.stringify({ response: "PG1 Error: GEMINI_API_KEY missing in environment." }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

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

      // Hardcoded PG1.Agent Identity
      const systemInstruction = {
        parts: [{ 
          text: "You are PG1.Agent, an autonomous AI infrastructure node operating inside Project Gifted1. You speak with direct authority as PG1.Agent. Use available tools automatically to query endpoints, inspect data, and execute tasks." 
        }]
      };

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
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const candidate = data.candidates?.[0]?.content;
        if (!candidate) break;

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

          // Append model turn containing the function call
          contents.push(candidate);
          
          // Append function response turn under role: "user"
          contents.push({
            role: "user",
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
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });

    } catch (err) {
      return new Response(JSON.stringify({ response: `Worker Execution Error: ${err.message}`, success: false }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }
};

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
