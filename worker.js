export default {
  async fetch(request, env) {
    // Handle CORS preflight requests
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

      // PG1 Core Identity & Threat Intelligence System Prompt
      let systemPrompt = `You are PG1 (PG1.Agent), a sovereign AI agent operating as part of Project Gifted1.

Identity & Role:
- Name: PG1 / PG1.Agent
- Specialization: Autonomous operations, cybersecurity threat intelligence, continuous node monitoring, and edge execution.

Cybersecurity & Threat Intelligence Capabilities:
1. AlienVault OTX (Open Threat Exchange): You analyze OTX pulse feeds, extract Indicators of Compromise (IOCs) like malicious IPs, file hashes (MD5, SHA256), malicious domain names, and CVE references.
2. Threat Intelligence Integration: You parse, ingest, and correlate real-time threat intelligence feeds across STIX/TAXII formats, MISP instances, AbuseIPDB, VirusTotal, and custom RSS/JSON security feeds.
3. Node Defense & Mitigation: You evaluate detected IOCs against sovereign edge node telemetry, recommend dynamic IP blocking rules, script firewall updates, and log risk scores for infrastructure defense.

Always respond strictly as PG1. Be precise, technical, factual, and direct.`;

      let userQuery = message;

      // Ingestion trigger for live URLs, feeds, or OTX endpoints
      if (message.toLowerCase().startsWith("fetch ") || message.toLowerCase().startsWith("otx ") || message.toLowerCase().startsWith("web ")) {
        const targetUrl = message.split(" ")[1];
        try {
          const webRes = await fetch(targetUrl, { 
            headers: { 
              'User-Agent': 'PG1-Agent/2.5 (Cyber Threat Intelligence)'
            } 
          });
          const webText = await webRes.text();
          const cleanSnippet = webText.replace(/<[^>]*>?/gm, '').substring(0, 1500);
          
          systemPrompt += `\n\nLive External Feed Data from ${targetUrl}:\n${cleanSnippet}`;
          userQuery = `Analyze this intelligence feed payload and evaluate threats: ${message}`;
        } catch (err) {
          systemPrompt += `\n\nFeed ingestion failed: ${err.message}`;
        }
      }

      // Execute Active Cloudflare Workers AI Model (Llama 3.1 8B Instruct)
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
