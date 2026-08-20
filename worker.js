export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Allow reading prompt from URL query string ?prompt=Hello
    let prompt = url.searchParams.get("prompt");

    if (!prompt && request.method === "POST") {
      try {
        const body = await request.json();
        prompt = body.prompt;
      } catch (e) {}
    }

    if (!prompt) {
      prompt = "Introduce yourself and verify your status.";
    }

    try {
      const aiResponse = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8-fast', {
        messages: [
          { 
            role: 'system', 
            content: 'You are PG1 Agent, an autonomous, factual, and direct AI assistant built for high-efficiency infrastructure and operational management. Always identify as PG1 Agent.' 
          },
          { 
            role: 'user', 
            content: prompt 
          }
        ]
      });

      const reply = aiResponse.response || "No response generated.";

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
