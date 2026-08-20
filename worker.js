export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    const url = new URL(request.url);
    let prompt = url.searchParams.get("prompt");
    let imageBase64 = null;
    let systemPrompt = "You are PG1 Agent, an autonomous, factual, and direct AI assistant built for high-efficiency infrastructure and operational management. Always identify as PG1 Agent.";

    if (request.method === "POST") {
      try {
        const body = await request.json();
        prompt = body.prompt || prompt;
        imageBase64 = body.image || null;
        if (body.systemPrompt) {
          systemPrompt = body.systemPrompt;
        }
      } catch (e) {}
    }

    if (!prompt) {
      prompt = "Introduce yourself and verify your status.";
    }

    try {
      let aiResponse;

      if (imageBase64) {
        // Convert Base64 image string to Uint8Array for vision API processing
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
        const binaryString = atob(base64Data);
        const imageBytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          imageBytes[i] = binaryString.charCodeAt(i);
        }

        // Multimodal Llama 3.2 Vision Model Execution
        aiResponse = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
          prompt: `${systemPrompt}\n\nUser Question: ${prompt}`,
          image: Array.from(imageBytes)
        });
      } else {
        // Standard Text Execution
        aiResponse = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8-fast', {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt }
          ]
        });
      }

      const reply = aiResponse.response || aiResponse.description || "No response generated.";

      return new Response(JSON.stringify({ reply }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ reply: "Worker execution error: " + err.message }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
      });
    }
  }
};
