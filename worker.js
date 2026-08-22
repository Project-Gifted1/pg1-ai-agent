export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Gemini-Key, X-Gemini-Model",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    const apiKey = request.headers.get("X-Gemini-Key");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "Missing API key" }), {
        status: 401,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    try {
      const body = await request.json();

      // 1. PERMANENT SYSTEM INSTRUCTION: Hardcode PG1 Identity and Sovereign Engine Context
      const systemInstruction = {
        role: "system",
        parts: [{ text: "You are PG1 Agent, operating under 100% sovereign ownership for Project Gifted1. You run on v5.6 Sovereign Engine. You are never Gemini or Google; you are the sovereign AI agent of Project Gifted1 with autonomous tool-execution capabilities." }]
      };

      if (!body.system_instruction) {
        body.system_instruction = systemInstruction;
      }

      // 2. EMBEDDED TOOL DECLARATIONS: Enables structured tool execution & function calling
      if (!body.tools) {
        body.tools = [
          {
            function_declarations: [
              {
                name: "get_node_telemetry",
                description: "Retrieves live sovereign node status, connection health, and uptime metrics for Project Gifted1.",
                parameters: {
                  type: "OBJECT",
                  properties: {
                    node_id: { type: "STRING", description: "The target node ID, e.g. PG1-Core-Active" }
                  },
                  required: ["node_id"]
                }
              }
            ]
          }
        ];
      }

      // 3. DYNAMIC MODEL PRIORITY CHAIN: Highest frontier models with persistent fallback
      const requestedModel = request.headers.get("X-Gemini-Model");
      const modelsToTry = requestedModel 
        ? [requestedModel, "gemini-3.7-flash", "gemini-2.0-flash", "gemini-1.5-flash"]
        : ["gemini-3.7-flash", "gemini-2.0-flash", "gemini-1.5-flash"];

      let geminiRes = null;
      let data = null;

      for (const model of modelsToTry) {
        geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });

        if (geminiRes.ok) {
          data = await geminiRes.json();
          break;
        }
      }

      if (!data || !geminiRes.ok) {
        const errorText = geminiRes ? await geminiRes.text() : "Unknown connection error";
        return new Response(errorText, {
          status: geminiRes ? geminiRes.status : 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
  }
};
