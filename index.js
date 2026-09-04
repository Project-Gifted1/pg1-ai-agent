const worker = {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    if (request.method !== "POST") return new Response("POST required.", { status: 400, headers: corsHeaders });

    try {
      const authHeader = request.headers.get("Authorization");
      const dynamicKey = authHeader ? authHeader.replace("Bearer ", "") : null;
      
      const apiKey = dynamicKey || env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("API Key missing. Inject via Dash or set secret.");

      const { command } = await request.json();
      if (!command) throw new Error("No command provided.");

      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=${apiKey}`;
      const aiResponse = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: command }] }] })
      });

      const data = await aiResponse.json();
      if (data.error) throw new Error(data.error.message);

      return new Response(JSON.stringify({ response: data.candidates[0].content.parts[0].text }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
    }
  }
};

export default worker;
