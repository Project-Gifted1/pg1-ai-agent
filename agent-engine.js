// agent-engine.js - PG1 Autonomous Runtime Override

(function () {
  console.log("[PG1 Agent Engine] Autonomous runtime loading...");

  const WORKER_URL = "https://pg1-worker.gnfcw9w5rk.workers.dev";

  function getStoredKey() {
    for (let i = 0; i < localStorage.length; i++) {
      const value = localStorage.getItem(localStorage.key(i));
      if (typeof value === "string" && value.startsWith("AIzaSy")) {
        return value;
      }
    }
    return "";
  }

  async function executeViaWorker(promptText) {
    try {
      const apiKey = getStoredKey();

      if (!apiKey) {
        return "PG1 Error: No valid key found in browser storage. Please re-enter your key in the Dash tab and click Save Key.";
      }

      const response = await fetch(WORKER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: promptText,
          apiKey: apiKey
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
