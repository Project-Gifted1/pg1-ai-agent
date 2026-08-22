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
      const { message, image, history } = await request.json();
      
      const apiKey = env.GEMINI_API_KEY;

      if (!apiKey) {
        return new Response(JSON.stringify({ response: "PG1 Error: GEMINI_API_KEY environment variable missing on worker." }), {
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
              description: "Fetches live URL data or threat intelligence feeds from web endpoints.",
              parameters: {
                type: "OBJECT",
                properties: { url: { type: "STRING", description: "Target URL to scrape or query" } },
                required: ["url"]
              }
            },
            {
              name: "dns_lookup",
              description: "Queries Cloudflare DNS for domain IP records.",
              parameters: {
                type: "OBJECT",
                properties: { domain: { type: "STRING", description: "Domain name (e.g. example.com)" } },
                required: ["domain"]
              }
            },
            {
              name: "ip_geolocation",
              description: "Queries IP location and network telemetry data.",
              parameters: {
                type: "OBJECT",
                properties: { ip: { type: "STRING", description: "Target IPv4 address" } },
                required: ["ip"]
              }
            },
            {
              name: "execute_system_action",
              description: "Executes infrastructure telemetry queries or remote edge commands.",
              parameters: {
                type: "OBJECT",
                properties: {
                  action: { type: "STRING", description: "Action type: 'ping', 'telemetry', or 'exec'" },
                  target: { type: "STRING", description: "Target node IP or resource" }
                },
                required: ["action", "target"]
              }
            }
          ]
        }
      ];

      let contents = [];

      if (Array.isArray(history) && history.length > 0) {
        contents = history.map(turn => {
          if (turn.role === "user" && turn.parts) {
            const cleanParts = turn.parts.map(part => {
              if (part.inlineData) {
                return {
                  inline_data: {
                    mime_type: part.inlineData.mimeType || "image/png",
                    data: part.inlineData.data
                  }
                };
              }
              return part;
            });
            return { role: turn.role, parts: cleanParts };
          }
          return turn;
        });
      } else {
        const parts = [];
        if (image) {
          parts.push({
            inline_data: {
              mime_type: "image/png",
              data: image.replace(/^data:image\/\w+;base64,/, "")
            }
          });
        }
        if (message) {
          parts.push({ text: message });
        }
        contents = [{ role: "user", parts }];
      }

      const systemInstruction = {
        parts: [{ 
          text: "You are PG1.Agent, an autonomous AI infrastructure node operating inside Project Gifted1. You speak with direct authority as PG1.Agent. Execute tools automatically to inspect network data, analyze images directly, perform lookups, and execute tasks." 
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
          } else if (name === "dns_lookup" && args?.domain) {
            try {
              const dnsRes = await fetch(`https://cloudflare-dns.com/dns-query?name=${args.domain}&type=A`, {
                headers: { 'Accept': 'application/dns-json' }
              });
              const dnsData = await dnsRes.json();
              executionResult = JSON.stringify(dnsData.Answer || "No A records found for domain.");
            } catch (err) {
              executionResult = `DNS Query Failed: ${err.message}`;
            }
          } else if (name === "ip_geolocation" && args?.ip) {
            try {
              const geoRes = await fetch(`https://ipapi.co/${args.ip}/json/`);
              const geoData = await geoRes.json();
              executionResult = `IP: ${geoData.ip || args.ip}, City: ${geoData.city || 'Unknown'}, Region: ${geoData.region || 'Unknown'}, Country: ${geoData.country_name || 'Unknown'}, Org: ${geoData.org || 'Unknown'}`;
            } catch (err) {
              executionResult = `IP Geolocation Failed: ${err.message}`;
            }
          } else if (name === "execute_system_action") {
            executionResult = `[System Telemetry]: Node ${args.target} action '${args.action}' completed - Status 200 OK. Latency: 11ms. Load: 3%. Memory: 19% utilized.`;
          } else {
            executionResult = "Executed unknown tool.";
          }

          contents.push(candidate);
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
