// agent-engine.js - Complete Native Function Override

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

  // Intercept file input selection
  document.addEventListener("change", (e) => {
    if (e.target && e.target.type === "file") {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          activeBase64Image = event.target.result;
          console.log("[PG1 Engine] Image Base64 captured.");
        };
        reader.readAsDataURL(file);
      }
    }
  }, true);

  // Extract base64 image payload from DOM or global memory
  function getCurrentImagePayload() {
    if (activeBase64Image) return activeBase64Image;

    const rawFile = window.attachedFile || window.pendingFile || window.currentFile;
    if (rawFile && rawFile instanceof File) {
      const reader = new FileReader();
      reader.readAsDataURL(rawFile);
    }

    const imgs = document.querySelectorAll("img");
    for (let i = imgs.length - 1; i >= 0; i--) {
      const src = imgs[i].src || "";
      if (src.startsWith("data:image")) {
        return src;
      }
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

      sessionHistory.push({
        role: "user",
        parts: userParts
      });

      const requestBody = {
        message: promptText || "Analyze this attached image.",
        history: sessionHistory,
        image: base64Image
      };

      activeBase64Image = null;
      window.attachedFile = null;
      window.pendingFile = null;

      const response = await fetch(WORKER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
      });

      const data = await response.json();
      const responseText = data.response || "No output returned from execution worker.";

      sessionHistory.push({
        role: "model",
        parts: [{ text: responseText }]
      });

      const payloadSize = new Blob([JSON.stringify(data)]).size;
      updateDashboardMetrics(payloadSize);

      return responseText;
    } catch (err) {
      return `Execution Bridge Error: ${err.message}`;
    }
  }

  async function handleExecution(promptText) {
    const chatArea = document.getElementById("terminal-chat-area") || document.querySelector(".chat-area");
    const inputEl = document.querySelector("input[type='text'], textarea, .command-input");
    const finalPrompt = promptText || (inputEl ? inputEl.value.trim() : "");

    if (!finalPrompt && !activeBase64Image) return;

    if (inputEl) inputEl.value = "";

    if (chatArea && finalPrompt) {
      const userBubble = document.createElement("div");
      userBubble.className = "chat-bubble user-bubble";
      userBubble.innerHTML = `<div class="bubble-text">${parseMarkdownToHTML(finalPrompt)}</div>`;
      chatArea.appendChild(userBubble);
    }

    const output = await executeViaWorker(finalPrompt);

    if (chatArea) {
      const aiBubble = document.createElement("div");
      aiBubble.className = "chat-bubble ai-bubble";
      aiBubble.innerHTML = `<div class="bubble-text">${parseMarkdownToHTML(output)}</div>`;
      chatArea.appendChild(aiBubble);
      chatArea.scrollTop = chatArea.scrollHeight;
    }
  }

  // Intercept Send button clicks in capturing phase to block index.html handlers
  window.addEventListener("click", (e) => {
    const btn = e.target.closest("button, .send-btn, #send-btn");
    if (btn && (btn.innerText.includes("Send") || btn.id === "send-btn")) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      handleExecution();
    }
  }, true);

  // Override window entry points
  window.sendTextPromptToGemini = async function (promptText) {
    handleExecution(promptText);
  };

  window.handleSendMessage = async function () {
    handleExecution();
  };
})();
