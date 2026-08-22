// agent-engine.js - Persistent DOM UI Patch

(function () {
  console.log("[PG1 Agent Engine] Autonomous runtime active.");

  const WORKER_URL = "https://pg1-agent-worker.gnfcw9w5rk.workers.dev";
  let sessionHistory = [];
  let totalBytesProcessed = 0;
  let totalRequests = 0;
  let activeBase64Image = null;

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

  function getChatContainer() {
    let chatArea = document.getElementById("terminal-chat-area") || document.querySelector(".chat-area");
    if (!chatArea) {
      chatArea = document.createElement("div");
      chatArea.id = "terminal-chat-area";
      chatArea.style.cssText = "padding:10px; overflow-y:auto; max-height:70vh;";
      document.body.appendChild(chatArea);
    }
    return chatArea;
  }

  function updateDashboardMetrics(bytesSent) {
    totalRequests++;
    totalBytesProcessed += bytesSent;

    const speedMbps = ((bytesSent * 8) / (1024 * 1024)).toFixed(2);
    const mbProcessed = (totalBytesProcessed / (1024 * 1024)).toFixed(2);

    const dashContainer = document.getElementById("dash-tab-content") || document.body;
    const statElements = dashContainer.querySelectorAll(".stat-card, .metric-value, .dash-stat, div, p");

    statElements.forEach(el => {
      if (el.innerText.includes("NaN") || el.innerText.includes("0 MB/s") || el.innerText.includes("Throughput:")) {
        el.innerHTML = `<strong>Throughput:</strong> ${speedMbps} Mbps | <strong>Processed:</strong> ${mbProcessed} MB | <strong>Requests:</strong> ${totalRequests}`;
      }
    });
  }

  document.addEventListener("change", (e) => {
    if (e.target && e.target.type === "file") {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          activeBase64Image = event.target.result;
        };
        reader.readAsDataURL(file);
      }
    }
  }, true);

  function getCurrentImagePayload() {
    if (activeBase64Image) return activeBase64Image;
    const imgs = document.querySelectorAll("img");
    for (let i = imgs.length - 1; i >= 0; i--) {
      const src = imgs[i].src || "";
      if (src.startsWith("data:image")) return src;
    }
    return null;
  }

  async function executeViaWorker(promptText) {
    try {
      const base64Image = getCurrentImagePayload();

      const userParts = [];
      if (base64Image) {
        userParts.push({
          inlineData: {
            mimeType: "image/png",
            data: base64Image.replace(/^data:image\/\w+;base64,/, "")
          }
        });
      }
      userParts.push({ text: promptText || "Analyze this attached image." });

      sessionHistory.push({ role: "user", parts: userParts });

      const requestBody = {
        message: promptText || "Analyze this attached image.",
        history: sessionHistory,
        image: base64Image
      };

      activeBase64Image = null;

      const response = await fetch(WORKER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
      });

      const data = await response.json();
      const responseText = data.response || "No output returned from execution worker.";

      sessionHistory.push({ role: "model", parts: [{ text: responseText }] });

      const payloadSize = new Blob([JSON.stringify(data)]).size;
      updateDashboardMetrics(payloadSize);

      return responseText;
    } catch (err) {
      return `Execution Bridge Error: ${err.message}`;
    }
  }

  async function handleExecution(promptText) {
    const chatArea = getChatContainer();
    const inputEl = document.querySelector("input[type='text'], textarea, .command-input");
    const finalPrompt = promptText || (inputEl ? inputEl.value.trim() : "");

    if (!finalPrompt && !activeBase64Image) return;

    if (inputEl) inputEl.value = "";

    if (finalPrompt) {
      const userBubble = document.createElement("div");
      userBubble.className = "chat-bubble user-bubble";
      userBubble.style.cssText = "background:#eef2ff; padding:12px; margin:8px 0; border-radius:8px;";
      userBubble.innerHTML = `<div>${parseMarkdownToHTML(finalPrompt)}</div>`;
      chatArea.appendChild(userBubble);
    }

    const output = await executeViaWorker(finalPrompt);

    const aiBubble = document.createElement("div");
    aiBubble.className = "chat-bubble ai-bubble";
    aiBubble.style.cssText = "background:#f3f4f6; padding:12px; margin:8px 0; border-radius:8px;";
    aiBubble.innerHTML = `<div>${parseMarkdownToHTML(output)}</div>`;
    chatArea.appendChild(aiBubble);
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  window.addEventListener("click", (e) => {
    const btn = e.target.closest("button, .send-btn, #send-btn");
    if (btn && (btn.innerText.includes("Send") || btn.id === "send-btn")) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      handleExecution();
    }
  }, true);

  window.sendTextPromptToGemini = async function (promptText) {
    handleExecution(promptText);
  };
})();
