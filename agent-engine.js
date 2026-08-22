// agent-engine.js - Direct DOM Base64 Extraction

(function () {
  console.log("[PG1 Agent Engine] Active.");

  const WORKER_URL = "https://pg1-agent-worker.gnfcw9w5rk.workers.dev";
  let sessionHistory = [];
  let stashedImageBase64 = null;

  function parseMarkdownToHTML(text) {
    if (!text) return "";
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br>');
  }

  // Intercept file picker directly
  document.addEventListener("change", (e) => {
    if (e.target && e.target.type === "file") {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          stashedImageBase64 = event.target.result;
          console.log("[PG1 Engine] Image base64 captured successfully.");
        };
        reader.readAsDataURL(file);
      }
    }
  }, true);

  // Read base64 from preview thumbnail if present
  function extractBase64FromDOM() {
    if (stashedImageBase64) return stashedImageBase64;

    const imgs = document.querySelectorAll("img");
    for (let i = imgs.length - 1; i >= 0; i--) {
      const src = imgs[i].src || "";
      if (src.startsWith("data:image")) {
        return src;
      }
    }
    return null;
  }

  async function executeWorker(promptText) {
    const base64Image = extractBase64FromDOM();
    const userParts = [];

    if (base64Image) {
      userParts.push({
        inlineData: {
          mimeType: "image/png",
          data: base64Image.replace(/^data:image\/\w+;base64,/, "")
        }
      });
    }
    userParts.push({ text: promptText || "Analyze this image." });

    sessionHistory.push({ role: "user", parts: userParts });

    const requestBody = {
      message: promptText || "Analyze this image.",
      history: sessionHistory,
      image: base64Image
    };

    stashedImageBase64 = null;

    const response = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });

    const data = await response.json();
    const responseText = data.response || "No response received.";

    sessionHistory.push({
      role: "model",
      parts: [{ text: responseText }]
    });

    return responseText;
  }

  // Override window function completely
  window.sendTextPromptToGemini = async function (promptText) {
    const inputEl = document.querySelector("input[type='text'], textarea, .command-input");
    const actualPrompt = promptText || (inputEl ? inputEl.value.trim() : "");

    const chatArea = document.getElementById("terminal-chat-area") || document.querySelector(".chat-area");

    if (chatArea && actualPrompt) {
      const userBubble = document.createElement("div");
      userBubble.className = "chat-bubble user-bubble";
      userBubble.innerHTML = `<div class="bubble-text">${parseMarkdownToHTML(actualPrompt)}</div>`;
      chatArea.appendChild(userBubble);
    }

    if (inputEl) inputEl.value = "";

    const responseText = await executeWorker(actualPrompt);

    if (chatArea) {
      const aiBubble = document.createElement("div");
      aiBubble.className = "chat-bubble ai-bubble";
      aiBubble.innerHTML = `<div class="bubble-text">${parseMarkdownToHTML(responseText)}</div>`;
      chatArea.appendChild(aiBubble);
      chatArea.scrollTop = chatArea.scrollHeight;
    }
  };
})();
