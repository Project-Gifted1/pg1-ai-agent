// agent-engine.js - PG1 Autonomous Runtime Override

(function () {
  console.log("[PG1 Agent Engine] Autonomous runtime loading...");

  const WORKER_URL = "https://pg1-worker.gnfcw9w5rk.workers.dev";

  async function executeViaWorker(promptText) {
    try {
      // Retrieve locally saved API key from storage
      const savedKey = localStorage.getItem("pg1_master_key") || localStorage.getItem("gemini_api_key") || "";

      const response = await fetch(WORKER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          message: promptText,
          apiKey: savedKey
        })
      });

      const data = await response.json();
      return data.response || "No output returned from execution worker.";
    } catch (err) {
      return `Execution Bridge Error: ${err.message}`;
    }
  }

  if (typeof window.sendTextPromptToGemini === "function") {
    window.sendTextPromptToGemini = async function (promptText) {
      const chatArea = document.getElementById("terminal-chat-area");
      
      if (chatArea) {
        const userBubble = document.createElement("div");
        userBubble.className = "chat-bubble user-bubble";
        userBubble.innerHTML = `<div class="bubble-text">${promptText}</div>`;
        chatArea.appendChild(userBubble);
      }

      const output = await executeViaWorker(promptText);

      if (chatArea) {
        const aiBubble = document.createElement("div");
        aiBubble.className = "chat-bubble ai-bubble";
        aiBubble.innerHTML = `<div class="bubble-text">${output}</div>`;
        chatArea.appendChild(aiBubble);
        chatArea.scrollTop = chatArea.scrollHeight;
      }
    };
    console.log("[PG1 Agent Engine] Hooked into UI successfully.");
  }
})();
