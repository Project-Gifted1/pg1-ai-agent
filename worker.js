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
      const { prompt, image } = await request.json();

      const systemPrompt = `You are PG1 Agent, an autonomous AI assistant managing Project Gifted1 infrastructure, operations, and sovereign AI node scaling. You have vision capabilities to inspect live camera feeds provided by the user. Always respond concisely, accurately, and professionally without repeating the user's command.`;

      let responseText = "";

      if (image && image.includes("base64,")) {
        const base64Data = image.split("base64,")[1];
        const binaryString = atob(base64Data);
        const imageBytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          imageBytes[i] = binaryString.charCodeAt(i);
        }

        const visionResponse = await env.AI.run(
          "@cf/meta/llama-3.2-11b-vision-instruct",
          {
            prompt: `${systemPrompt}\n\nUser Command: ${prompt}`,
            image: Array.from(imageBytes),
            max_tokens: 512
          }
        );
        responseText = visionResponse.response || "Frame processed.";
      } else {
        const textResponse = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct",
          {
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: prompt }
            ],
            max_tokens: 512
          }
        );
        responseText = textResponse.response || "Command executed.";
      }

      return new Response(JSON.stringify({ reply: responseText.trim() }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });

    } catch (err) {
      return new Response(JSON.stringify({ reply: `Worker AI Error: ${err.message}` }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
  }
};
