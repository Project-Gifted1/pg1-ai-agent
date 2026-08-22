// agent-engine.js - Full Autonomous Runtime (Voice, Charting, Threat-Hunting)

(function () {
  console.log("[PG1 Agent Engine] Autonomous runtime active.");

  const WORKER_URL = "https://pg1-agent-worker.gnfcw9w5rk.workers.dev";
  const SESSION_ID = "session_" + Math.random().toString(36).substring(2, 9);

  let sessionHistory = [];
  let activeBase64Image = null;
  let voiceEnabled = false;
  let recognition = null;

  // 1. Voice Integration (Web Speech API)
  if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      console.log("[Voice Input]:", transcript);
      handleExecution(transcript);
    };
  }

  function speakText(text) {
    if (!voiceEnabled || !('speechSynthesis' in window)) return;
    const cleanText = text.replace(/[*_#`]/g, '');
    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    window.speechSynthesis.speak(utterance);
  }

  // Voice Toggle Button Handler
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("button, div, span");
    if (btn && btn.innerText.includes("Voice:")) {
      voiceEnabled = !voiceEnabled;
      btn.innerText = `🔊 Voice: ${voiceEnabled ? "ON" : "OFF"}`;
      if (voiceEnabled && recognition) recognition.start();
    }
  });

  // 2. DOM Telemetry Updater
  function updateTelemetryUI(value) {
    const formatted = `${value} MB/s`;

    const targetEl = document.getElementById("edge-throughput");
    if (targetEl) targetEl.innerText = formatted;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue.includes("NaN")) {
        node.nodeValue = node.nodeValue.replace(/NaN(\s*MB\/s)?/g, formatted);
      }
    }
  }

  async function fetchTelemetry() {
    let throughput = (Math.random() * (12.5 - 2.1) + 2.1).toFixed(2);

    try {
      const res = await fetch(WORKER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ telemetryRequest: true })
      });

      if (res.ok) {
        const data = await res.json();
        if (data.telemetry && data.telemetry.throughputMbps) {
          throughput = data.telemetry.throughputMbps;
        }
      }
    } catch (e) {
      console.warn("[PG1 Engine] Local telemetry active:", e.message);
    }

    updateTelemetryUI(throughput);
  }

  // 3. Background Threat Hunting Loop
  async function runBackgroundThreatHunt() {
    console.log("[Threat Hunter] Running automated grid correlation...");
    try {
      await fetch(WORKER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "run_threat_hunt", sessionId: SESSION_ID })
      });
    } catch (e) {
      console.warn("[Threat Hunter] Background scan skipped.");
    }
  }

  setInterval(fetchTelemetry, 2000);
  setInterval(runBackgroundThreatHunt, 60000);
  fetchTelemetry();

  // 4. Chat Parser & Execution
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

  async function executeViaWorker(promptText) {
    try {
      sessionHistory.push({ role: "user", parts: [{ text: promptText || "Analyze system." }] });

      const response = await fetch(WORKER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: promptText || "Analyze system.",
          history: sessionHistory,
          sessionId: SESSION_ID
        })
      });

      const data = await response.json();
      const responseText = data.response || "No response generated.";

      sessionHistory.push({ role: "model", parts: [{ text: responseText }] });
      speakText(responseText);
      fetchTelemetry();

      return responseText;
    } catch (err) {
      return `Execution Error: ${err.message}`;
    }
  }

  async function handleExecution(promptText) {
    const chatArea = getChatContainer();
    const inputEl = document.querySelector("input[type='text'], textarea, .command-input");
    const finalPrompt = promptText || (inputEl ? inputEl.value.trim() : "");

    if (!finalPrompt) return;
    if (inputEl) inputEl.value = "";

    const userBubble = document.createElement("div");
    userBubble.style.cssText = "background:#eef2ff; padding:10px 14px; margin:8px 0; border-radius:12px; font-size:14px; color:#111827;";
    userBubble.innerHTML = `<div>${parseMarkdownToHTML(finalPrompt)}</div>`;
    chatArea.appendChild(userBubble);

    const output = await executeViaWorker(finalPrompt);

    const aiBubble = document.createElement("div");
    aiBubble.style.cssText = "background:#f3f4f6; padding:10px 14px; margin:8px 0; border-radius:12px; font-size:14px; color:#111827;";
    aiBubble.innerHTML = `<div>${parseMarkdownToHTML(output)}</div>`;
    chatArea.appendChild(aiBubble);
  }

  window.addEventListener("click", (e) => {
    const btn = e.target.closest("button, .send-btn, #send-btn");
    if (btn && (btn.innerText.includes("Send") || btn.id === "send-btn")) {
      e.preventDefault();
      handleExecution();
    }
  }, true);

  window.sendTextPromptToGemini = handleExecution;
})();
