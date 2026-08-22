// agent-engine.js - Direct Input Bridge

(function () {
  console.log("[PG1 Agent Engine] Autonomous runtime loading...");

  const WORKER_URL = "https://pg1-worker.gnfcw9w5rk.workers.dev";

  function extractKey() {
    // 1. Scan DOM input fields directly
    const inputs = document.querySelectorAll("input[type='password'], input[type='text']");
    for (const input of inputs) {
      if (input.value && input.value.trim().startsWith("AIzaSy")) {
        return input.value.trim();
      }
    }

    // 2. Scan localStorage items
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const val = localStorage.getItem(key);
      if (typeof val === "string" && val.trim().startsWith("AIzaSy")) {
        return val.trim();
      }
    }

    return "";
  }

  async function executeViaWorker(promptText) {
    try {
      const apiKey = extractKey();

      if (!apiKey) {
        return "PG1 Error: Gemini API Key not detected in UI input or localStorage. Make sure your key starting with 'AIzaSy' is pasted into the input field on the Dash tab.";
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
