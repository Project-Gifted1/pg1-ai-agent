// agent-engine.js - PG1 Autonomous Runtime Engine

(function () {
  console.log("[PG1 Agent Engine] Autonomous runtime active.");

  const WORKER_URL = "https://pg1-agent-worker.gnfcw9w5rk.workers.dev";
  let sessionHistory = [];
  let totalBytesProcessed = 0;
  let totalRequests = 0;

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

  // Extract base64 from window file object or inline img tag
  async function resolveImageBase64() {
    const rawFile = window.attachedFile || window.pendingFile || window.currentFile;
    if (rawFile && rawFile instanceof File) {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(rawFile);
      });
    }

    const imgElements = document.querySelectorAll("img");
    for (let i = imgElements.length - 1; i >= 0; i--) {
      const src = imgElements[i].src || "";
      if (src.startsWith("data:image")) {
        return src;
      }
    }

    return null;
  }

  async function executeViaWorker(promptText) {
    try {
      const base64Image = await resolveImageBase64();

      const userParts = [];
      if (base64Image) {
        userParts.push({
          inlineData: {
            mimeType: "image/png",
            data: base64Image.replace(/^data:image\/\w+;base64,/, "")
          }
        });
      }
      userParts.push({ text: promptText });

      sessionHistory.push({
        role: "user",
        parts: userParts
      });

      const requestBody = {
        message: promptText,
        history: sessionHistory,
        image: base64Image
      };

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

      window.attachedFile = null;
      window.pendingFile = null;
      window.currentFile = null;

      const payloadSize = new Blob([JSON.stringify(data)]).size;
      updateDashboardMetrics(payloadSize);

      return responseText;
    } catch (err) {
      return `Execution Bridge Error: ${err.message}`;
    }
  }

  window.sendTextPromptToGemini = async function (promptText) {
    const chatArea = document.getElementById("terminal-chat-area");

    if (chatArea) {
      const userBubble = document.createElement("div");
      userBubble.className = "chat-bubble user-bubble";
      userBubble.innerHTML = `<div class="bubble-text">${parseMarkdownToHTML(promptText)}</div>`;
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
  };
})();
