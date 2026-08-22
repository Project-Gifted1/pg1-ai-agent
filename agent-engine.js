// agent-engine.js - PG1 Autonomous Agent Execution Engine

// 1. Tool Definitions Schema
const agentTools = [
  {
    functionDeclarations: [
      {
        name: "execute_system_action",
        description: "Sends automated HTTP requests to external APIs, local bridge endpoints, or microservices.",
        parameters: {
          type: "OBJECT",
          properties: {
            endpoint: { type: "STRING", description: "Target URL or local proxy route" },
            method: { type: "STRING", enum: ["GET", "POST", "PUT", "DELETE"] },
            payload: { type: "STRING", description: "Payload or parameters passed to the endpoint" }
          },
          required: ["endpoint", "method"]
        }
      },
      {
        name: "query_device_telemetry",
        description: "Queries current system state, memory, or edge node network health.",
        parameters: {
          type: "OBJECT",
          properties: {
            metric: { type: "STRING", description: "Metric type: 'cpu', 'memory', or 'network'" }
          },
          required: ["metric"]
        }
      }
    ]
  }
];

// 2. Local Action Handlers
async function handleLocalExecution(functionName, args) {
  console.log(`[PG1 Engine] Executing Action: ${functionName}`, args);

  if (functionName === "execute_system_action") {
    try {
      const options = {
        method: args.method,
        headers: { "Content-Type": "application/json" }
      };
      if (args.payload && args.method !== "GET") {
        options.body = typeof args.payload === "string" ? args.payload : JSON.stringify(args.payload);
      }
      const res = await fetch(args.endpoint, options);
      const output = await res.text();
      return `Status ${res.status}: ${output}`;
    } catch (err) {
      return `Execution Error: ${err.message}`;
    }
  }

  if (functionName === "query_device_telemetry") {
    return JSON.stringify({
      status: "online",
      requestedMetric: args.metric,
      timestamp: new Date().toISOString()
    });
  }

  return "Unknown tool execution requested.";
}

// 3. Autonomous Loop
async function runAgentTurn(userObjective, history = [], turnCount = 0) {
  const maxTurns = 5; // Guardrail against infinite tool loops
  if (turnCount >= maxTurns) {
    return "Reached maximum autonomous execution steps for this turn.";
  }

  const apiKey = localStorage.getItem("pg1_api_key");
  if (!apiKey) return "Error: API Key not configured.";

  const selectedModel = document.getElementById("model-select")?.value || "gemini-3.6-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${apiKey}`;

  const currentHistory = history.length > 0 ? history : [
    { role: "user", parts: [{ text: userObjective }] }
  ];

  const requestBody = {
    system_instruction: {
      parts: [{
        text: "You are PG1.Agent, an autonomous agent capable of calling tools to complete tasks. Use functions directly to accomplish multi-step objectives."
      }]
    },
    contents: currentHistory,
    tools: agentTools
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });

    const data = await response.json();
    const candidate = data.candidates?.[0]?.content;
    if (!candidate) return "Execution error: Empty model response.";

    // Check if model called a tool
    const functionCallPart = candidate.parts?.find(p => p.functionCall);

    if (functionCallPart) {
      const { name, args } = functionCallPart.functionCall;
      
      // Execute the local JavaScript function
      const result = await handleLocalExecution(name, args);

      // Append assistant's call and execution result to chat history
      const updatedHistory = [
        ...currentHistory,
        candidate,
        {
          role: "function",
          parts: [{
            functionResponse: {
              name: name,
              response: { output: result }
            }
          }]
        }
      ];

      // Automatically run next step
      return await runAgentTurn(userObjective, updatedHistory, turnCount + 1);
    }

    // Return final text output once all tool calls finish
    return candidate.parts?.[0]?.text || "Task complete.";
  } catch (err) {
    return `Agent Loop Error: ${err.message}`;
  }
}
