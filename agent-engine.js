// Add inside agent-engine.js handleExecution function to enable terminal status indicators
function renderSystemStatus(statusText) {
  const chatArea = getChatContainer();
  const statusEl = document.createElement("div");
  statusEl.className = "agent-status-indicator";
  statusEl.style.cssText = "font-size: 11px; color: #10B981; font-family: monospace; margin: 4px 0;";
  statusEl.innerText = `[AGENT ENGINE]: ${statusText}`;
  chatArea.appendChild(statusEl);
  chatArea.scrollTop = chatArea.scrollHeight;
}
