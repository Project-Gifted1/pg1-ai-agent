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

      // Updated to gemini-2.5-flash to prevent free tier rate-limit exhaustion
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

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

      parts.push({ text: message || "Analyze current frame." });
      contents.push({ parts });

      const geminiRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents })
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
