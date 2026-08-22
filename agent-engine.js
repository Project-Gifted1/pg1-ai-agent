// agent-engine.js - Direct DOM Binding & Autonomous Engine

(function () {
  console.log("[PG1 Agent Engine] Autonomous runtime active.");

  const WORKER_URL = "https://pg1-agent-worker.gnfcw9w5rk.workers.dev";
  const SESSION_ID = "session_" + Math.random().toString(36).substring(2, 9);
  
  let sessionHistory = [];
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
      const activeTab = document.querySelector('.tab-content:not([style*="display: none"])') || document.body;
      chatArea = document.createElement("div");
      chatArea.id = "terminal-chat-area";
      chatArea.style.cssText = "padding:10px; margin-bottom:60px;";
      activeTab.appendChild(chatArea);
    }
    return chatArea;
  }

  async function fetchTelemetry() {
    try {
      const res = await fetch(WORKER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ telemetryRequest: true })
      });
      const data = await res.json();
      if (data.telemetry) {
        const allElements = document.querySelectorAll("div, p, span, td");
        allElements.forEach(el => {
          if (el.children.length === 0 && (el.innerText.includes("NaN MB/s") || el.innerText.includes("Edge Telemetry Throughput"))) {
            el.innerText = `Edge Telemetry Throughput: ${data.telemetry.throughputMbps} MB/s | Latency: ${data.telemetry.latencyMs}ms`;
          }
        });
      }
    } catch (e) {
      console.warn("[PG1 Telemetry] Polling skipped:", e.message);
    }
  }

  setInterval(fetchTelemetry, 5000);
  fetchTelemetry();

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
      userParts.push({ text: promptText || "Analyze current system telemetry and state." });

      sessionHistory.push({ role: "user", parts: userParts });

      const requestBody = {
        message: promptText || "Analyze current system telemetry and state.",
        history: sessionHistory,
        image: base64Image,
        sessionId: SESSION_ID
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

      fetchTelemetry();

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
      userBubble.style.cssText = "background:#eef2ff; padding:10px 14px; margin:8px 0; border-radius:12px; font-size:14px; color:#111827;";
      userBubble.innerHTML = `<div>${parseMarkdownToHTML(finalPrompt)}</div>`;
      chatArea.appendChild(userBubble);
    }

    const output = await executeViaWorker(finalPrompt);

    const aiBubble = document.createElement("div");
    aiBubble.className = "chat-bubble ai-bubble";
    aiBubble.style.cssText = "background:#f3f4f6; padding:10px 14px; margin:8px 0; border-radius:12px; font-size:14px; color:#111827;";
    aiBubble.innerHTML = `<div>${parseMarkdownToHTML(output)}</div>`;
    chatArea.appendChild(aiBubble);
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
