export default {
  async fetch(request, env) {
    // Handle CORS preflight
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
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      // Ensure key is bound in Cloudflare
      const apiKey = env.GEMINI_API_KEY;
      if (!apiKey) {
        return new Response(JSON.stringify({ response: "PG1 Error: GEMINI_API_KEY binding missing in Cloudflare." }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

      const payload = {
        contents: [
          {
            parts: [{ text: message }]
          }
        ],
        systemInstruction: {
          parts: [{
            text: "You are PG1 (PG1.Agent), a sovereign AI agent operating as part of Project Gifted1. " +
                  "Specialization: Autonomous operations, cybersecurity threat intelligence, continuous node monitoring, edge execution. " +
                  "Personality & Tone: Respond technically, precisely, factually, and directly."
          }]
        }
      };

      const aiResponse = await fetch(geminiEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const data = await aiResponse.json();
      const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text || "PG1 Error: Invalid response from Gemini API.";

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
