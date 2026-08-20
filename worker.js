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
      const { type, prompt } = await request.json();
      let endpoint = 'https://api.openai.com/v1/chat/completions';
      let payload = {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }]
      };

      const apiResponse = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.API_KEY}`
        },
        body: JSON.stringify(payload)
      });

      const data = await apiResponse.json();
      const reply = data.choices?.[0]?.message?.content || "No response generated.";

      return new Response(JSON.stringify({ reply }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ reply: "Proxy execution error: " + err.message }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
      });
    }
  }
};
