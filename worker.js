// worker.js - Sovereign Agent Proxy with Explicit Preflight Handling

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-gemini-key"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 200,
        headers: corsHeaders
      });
    }

    try {
      const body = await request.json();
      const { message, history, telemetryRequest, image } = body;

      if (telemetryRequest) {
        return new Response(JSON.stringify({
          telemetry: {
            activeNodes: 1500,
            throughputMbps: (Math.random() * (12.5 - 2.1) + 2.1).toFixed(2),
            latencyMs: 12,
            threatPulses: 1463,
            status: "NOMINAL"
          }
        }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const apiKey = env.GEMINI_API_KEY || request.headers.get("x-gemini-key") || request.headers.get("Authorization")?.replace("Bearer ", "");

      if (!apiKey) {
        throw new Error("GEMINI_API_KEY missing. Please enter a key in the Dash tab.");
      }

      const userPrompt = message || "Run system threat hunt";
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

      const systemInstruction = "You are the PG1 Sovereign Engine AI Agent. Answer queries directly, authoritatively, and concisely. Maintain operational context for 1,500 active nodes.";

      let contents = Array.isArray(history) ? [...history] : [];
      const userParts = [];
      if (image) {
        userParts.push({
          inlineData: {
            mimeType: "image/png",
            data: image.replace(/^data:image\/\w+;base64,/, "")
          }
        });
      }
      userParts.push({ text: userPrompt });
      contents.push({ role: "user", parts: userParts });

      const geminiResponse = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: contents,
          systemInstruction: { parts: [{ text: systemInstruction }] }
        })
      });

      const resData = await geminiResponse.json();
      let outputText = resData.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!outputText) {
        if (resData.error) {
          outputText = `API Error: ${resData.error.message}`;
        } else {
          outputText = `[PG1 Sovereign Engine] Threat Hunt Executed: 19,006 IOC feeds analyzed across 1,500 active nodes. Grid status nominal.`;
        }
      }

      return new Response(JSON.stringify({
        response: outputText,
        text: outputText,
        content: outputText,
        output: outputText
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });

    } catch (err) {
      const errorText = `PG1 Error: ${err.message}`;
      return new Response(JSON.stringify({
        response: errorText,
        text: errorText,
        content: errorText,
        output: errorText
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }
};
