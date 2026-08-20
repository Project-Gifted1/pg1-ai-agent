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
      const { message } = await request.json();
      if (!message) {
        return new Response(JSON.stringify({ response: "No command provided." }), {
          headers: { 
            "Content-Type": "application/json", 
            "Access-Control-Allow-Origin": "*" 
          }
        });
      }

      let systemPrompt = `You are PG1 (PG1.Agent), a sovereign AI agent operating as part of Project Gifted1.
Identity & Role: Name PG1 / PG1.Agent. Specialization: Autonomous operations, cybersecurity threat intelligence, continuous node monitoring, edge execution.
Always respond strictly as PG1. Be precise, technical, factual, and direct.`;

      let userQuery = message;

      if (message.toLowerCase().startsWith("fetch ") || message.toLowerCase().startsWith("otx ") || message.toLowerCase().startsWith("web ")) {
        const targetUrl = message.split(" ")[1];
        try {
          const webRes = await fetch(targetUrl, { 
            headers: { 'User-Agent': 'PG1-Agent/2.5 (Cyber Threat Intelligence)' } 
          });
          const webText = await webRes.text();
          const cleanSnippet = webText.replace(/<[^>]*>?/gm, '').substring(0, 1500);
          
          systemPrompt += `\n\nLive External Feed Data from ${targetUrl}:\n${cleanSnippet}`;
          userQuery = `Analyze this intelligence feed payload and evaluate threats: ${message}`;
        } catch (err) {
          systemPrompt += `\n\nFeed ingestion failed: ${err.message}`;
        }
      }

      // Model ID corrected to active Cloudflare endpoint
      const aiResponse = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userQuery }
        ]
      });

      const replyText = aiResponse.response || "PG1 Task executed successfully.";

      return new Response(JSON.stringify({ response: replyText }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });

    } catch (err) {
      return new Response(JSON.stringify({ response: `PG1 System Error: ${err.message}` }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
  },
};
