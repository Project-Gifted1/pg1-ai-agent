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
      const { message, image } = await request.json();
      const apiKey = env.GEMINI_API_KEY;

      if (!apiKey) {
        return new Response(JSON.stringify({ error: "API Key missing in Worker environment." }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

      const contents = [];
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
      contents.push({ parts });

      // System instruction grounds PG1 identity
      const systemInstruction = {
        parts: [{ text: "You are PG1.Agent, an autonomous AI infrastructure node operating inside Project Gifted1. Answer all user queries strictly from the operational context of Project Gifted1." }]
      };

      const geminiRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents, systemInstruction })
      });

      const data = await geminiRes.json();

      if (data.error) {
        return new Response(JSON.stringify({ response: `PG1 Error: ${data.error.message}` }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || "No response received.";

      return new Response(JSON.stringify({ response: reply }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });

    } catch (err) {
      return new Response(JSON.stringify({ response: `Worker Execution Error: ${err.message}` }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
  }
};
