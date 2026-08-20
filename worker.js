export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // Handle Safari CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
    }

    try {
      const { prompt, image } = await request.json();

      const systemPrompt = `You are PG1 Agent, an autonomous AI assistant managing Project Gifted1 infrastructure, operations, and sovereign AI node scaling. You have vision capabilities to inspect live camera feeds provided by the user. Always respond concisely, accurately, and professionally without repeating the user's command.`;

      let responseText = "";

      // Process vision payload if image base64 exists
      if (image && typeof image === "string" && image.includes("base64,")) {
        const base64Data = image.split("base64,")[1];
        const binaryString = atob(base64Data);
        const imageBytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          imageBytes[i] = binaryString.charCodeAt(i);
        }

        const visionResponse = await env.AI.run(
          "@cf/meta/llama-3.2-11b-vision-instruct",
          {
            prompt: `${systemPrompt}\n\nUser Command: ${prompt || "Analyze image"}`,
            image: Array.from(imageBytes),
            max_tokens: 512
          }
        );
        responseText = visionResponse.response || "Frame analyzed successfully.";
      } else {
        // Text-only fallback
        const textResponse = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct",
          {
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: prompt || "System status check" }
            ],
            max_tokens: 512
          }
        );
        responseText = textResponse.response || "Command processed.";
      }

      return new Response(JSON.stringify({ reply: responseText.trim() }), {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      });

    } catch (err) {
      return new Response(JSON.stringify({ reply: `Worker Execution Error: ${err.message}` }), {
        status: 200, // Return 200 with error details so browser doesn't throw generic 'Load failed'
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      });
    }
  }
};
