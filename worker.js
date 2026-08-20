export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const { prompt } = await request.json();

      // Call Cloudflare Workers AI for free using Llama 3.1 or a comparable open model
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
