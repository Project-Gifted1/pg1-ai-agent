// agent-engine.js - PG1 Autonomous Runtime Engine

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
      .replace(/^\*\s+(.*)$/gbm, '<ul><li>$1</li></ul>')
      .replace(/<\/ul>\n<ul>/g, '')
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

  // Intercept file selection globally and prevent auto-submit
  document.addEventListener("change", (e) => {
    if (e.target && e.target.type === "file") {
      e.stopPropagation();
      e.stopImmediatePropagation();

      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          activeBase64Image = event.target.result;
          console.log("[PG1 Agent Engine] Image loaded into memory. Waiting for Send click.");
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

      // Reset image state after sending
      activeBase64Image = null;

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

  async function handleUserSubmit(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }

    const inputEl = document.querySelector("input[type='text'], textarea, .command-input");
    const promptText = inputEl ? inputEl.value.trim() : "";

    if (!promptText && !activeBase64Image) return;

    if (inputEl) inputEl.value = "";

    const chatArea = document.getElementById("terminal-chat-area") || document.querySelector(".chat-area");

    if (chatArea) {
      const userBubble = document.createElement("div");
      userBubble.className = "chat-bubble user-bubble";
      userBubble.innerHTML = `<div class="bubble-text">${parseMarkdownToHTML(promptText || "Sent attached image")}</div>`;
      chatArea.appendChild(userBubble);
    }

    const output = await executeViaWorker(promptText);

    if (chatArea) {
      const aiBubble = document.createElement("div");
      aiBubble.className = "chat-bubble ai-bubble";
      aiBubble.innerHTML = `<div class="bubble-text">${parseMarkdownToHTML(output)}</div>`;
      chatArea.appendChild(aiBubble);
      chatArea.scrollTop = chatArea.scrollHeight;
    }
  }

  // Intercept click on Send button
  window.addEventListener("click", (e) => {
    const btn = e.target.closest("button, .send-btn, #send-btn");
    if (btn && (btn.innerText.includes("Send") || btn.id === "send-btn")) {
      handleUserSubmit(e);
    }
  }, true);

  // Block native auto-trigger
  window.sendTextPromptToGemini = function () {
    console.log("[PG1 Agent Engine] Blocked native auto-trigger on image select.");
    return false;
  };
})();
