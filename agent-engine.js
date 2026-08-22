// agent-engine.js - PG1 Autonomous Runtime Override

(function () {
  console.log("[PG1 Agent Engine] Autonomous runtime loading...");

  // 1. Tool Schemas
  const agentTools = [{
    functionDeclarations: [
      {
        name: "execute_system_action",
        description: "Executes an API request or remote proxy task.",
        parameters: {
          type: "OBJECT",
          properties: {
            endpoint: { type: "STRING" },
            method: { type: "STRING", enum: ["GET", "POST", "PUT", "DELETE"] },
            payload: { type: "STRING" }
          },
          required: ["endpoint", "method"]
        }
      }
    ]
  }];

  // 2. Action Runner
  async function handleLocalExecution(functionName, args) {
    if (functionName === "execute_system_action") {
      try {
        const res = await fetch(args.endpoint, { method: args.method, body: args.payload });
        return await res.text();
      } catch (err) {
        return `Execution Error: ${err.message}`;
      }
    }
    return "Unknown action.";
  }

  // 3. Loop Engine
  async function runAutonomousLoop(userObjective, history = [], turnCount = 0) {
    if (turnCount >= 5) return "Maximum autonomous steps reached.";
    
    const apiKey = localStorage.getItem("pg1_api_key");
    const selectedModel = document.getElementById("model-select")?.value || "gemini-3.6-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${apiKey}`;

    const currentHistory = history.length > 0 ? history : [
      { role: "user", parts: [{ text: userObjective }] }
    ];

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: "You are PG1.Agent. Execute tasks autonomously using available tools." }] },
        contents: currentHistory,
        tools: agentTools
      })
    });

    const data = await response.json();
    const candidate = data.candidates?.[0]?.content;
    const functionCallPart = candidate?.parts?.find(p => p.functionCall);

    if (functionCallPart) {
      const { name, args } = functionCallPart.functionCall;
      const result = await handleLocalExecution(name, args);

      const updatedHistory = [
        ...currentHistory,
        candidate,
        { role: "function", parts: [{ functionResponse: { name, response: { output: result } } }] }
      ];

      return await runAutonomousLoop(userObjective, updatedHistory, turnCount + 1);
    }

    return candidate?.parts?.[0]?.text || "Task finished.";
  }

  // 4. In-Memory Override (Leaves index.html completely untouched)
  if (typeof window.sendTextPromptToGemini === "function") {
    const originalSend = window.sendTextPromptToGemini;
    
    window.sendTextPromptToGemini = async function (promptText) {
      // Intercept and pass execution to the autonomous loop engine
      const output = await runAutonomousLoop(promptText);
      
      // Target existing chat bubble container in index.html to render output
      const chatArea = document.getElementById("terminal-chat-area");
      if (chatArea) {
        const aiBubble = document.createElement("div");
        aiBubble.className = "chat-bubble";
        aiBubble.innerHTML = `<div class="bubble-text">${output}</div>`;
        chatArea.appendChild(aiBubble);
        chatArea.scrollTop = chatArea.scrollHeight;
      }
    };
    console.log("[PG1 Agent Engine] Hooked into UI successfully.");
  }
})();
