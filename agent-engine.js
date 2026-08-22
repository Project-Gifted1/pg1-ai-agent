// agent-engine.js - PG1 Autonomous Runtime Override (Worker Integrated)

(function () {
  console.log("[PG1 Agent Engine] Autonomous runtime loading...");

  // REPLACE THIS WITH YOUR ACTUAL CLOUDFLARE WORKER URL
  const WORKER_URL = "https://your-worker-subdomain.workers.dev";

  async function executeViaWorker(promptText) {
    try {
      const response = await fetch(WORKER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: promptText })
      });

      const data = await response.json();
      return data.response || "No output returned from execution worker.";
    } catch (err) {
      return `Execution Bridge Error: ${err.message}`;
    }
  }

  // Override chat handler to route requests directly to Cloudflare Worker
  if (typeof window.sendTextPromptToGemini === "function") {
    window.sendTextPromptToGemini = async function (promptText) {
      const chatArea = document.getElementById("terminal-chat-area");
      
      // Render user prompt bubble
      if (chatArea) {
        const userBubble = document.createElement("div");
        userBubble.className = "chat-bubble user-bubble";
        userBubble.innerHTML = `<div class="bubble-text">${promptText}</div>`;
        chatArea.appendChild(userBubble);
      }

      // Execute action via worker and fetch response
      const output = await executeViaWorker(promptText);

      // Render agent response bubble
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
