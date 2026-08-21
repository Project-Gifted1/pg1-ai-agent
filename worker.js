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

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      const { message } = await request.json();

      if (!message) {
        return new Response(JSON.stringify({ response: "No message provided." }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }

      const apiKey = env.GEMINI_API_KEY;
      if (!apiKey) {
        return new Response(JSON.stringify({ response: "PG1 Error: GEMINI_API_KEY secret is missing in Cloudflare/GitHub Secrets." }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: {
            parts: [
              {
                text: "You are PG1 (PG1.Agent), a sovereign AI agent operating as part of Project Gifted1. Specialization: Autonomous operations, cybersecurity threat intelligence, continuous node monitoring, edge execution. Personality & Tone: Respond technically, precisely, factually, and directly."
              }
            ]
          },
          contents: [
            {
              parts: [{ text: message }]
            }
          ]
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.candidates || !data.candidates[0]?.content?.parts[0]?.text) {
        const errDetail = data.error?.message || response.statusText || "Unknown API issue";
        return new Response(
          JSON.stringify({ response: `PG1 Error: Invalid response from Gemini API. (${errDetail})` }),
          {
            status: 200,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          }
        );
      }

      const replyText = data.candidates[0].content.parts[0].text;

      return new Response(JSON.stringify({ response: replyText }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ response: `PG1 System Error: ${err.message}` }),
        {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        }
      );
    }
  },
};
