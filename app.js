const CLOUDFLARE_WORKER_URL = 'https://pg1-agent-worker.gnfcw9w5rk.workers.dev';

let currentSessionId = 'session_default';
let sessions = JSON.parse(localStorage.getItem('pg1_sessions')) || {
  'session_default': { name: 'Session 1', messages: [] }
};

document.addEventListener('DOMContentLoaded', () => {
  updateSessionDropdown();
  loadCurrentSession();
  startLiveDashboardTelemetry();
});

function startLiveDashboardTelemetry() {
  setInterval(() => {
    const cpuVal = Math.floor(Math.random() * (48 - 22 + 1)) + 22;
    const memVal = Math.floor(Math.random() * (62 - 41 + 1)) + 41;
    const bwVal = (Math.random() * (3.8 - 1.1) + 1.1).toFixed(1);
    const pingVal = Math.floor(Math.random() * (28 - 12 + 1)) + 12;
    const threatCount = Math.floor(Math.random() * (1420 - 1380 + 1)) + 1380;

    updateMetric('dash-cpu-pct', 'dash-cpu-bar', cpuVal, '%');
    updateMetric('dash-mem-pct', 'dash-mem-bar', memVal, '%');
    updateMetric('dash-bw-pct', 'dash-bw-bar', bwVal, ' MB/s', 5);
    
    const pingPct = document.getElementById('dash-ping-pct');
    const iocPct = document.getElementById('dash-ioc-pct');
    if (pingPct) pingPct.innerText = `${pingVal} ms`;
    if (iocPct) iocPct.innerText = `${threatCount} Ingested`;
  }, 2000);
}

function updateMetric(txtId, barId, val, suffix, max = 100) {
  const txt = document.getElementById(txtId);
  const bar = document.getElementById(barId);
  if (txt && bar) {
    txt.innerText = `${val}${suffix}`;
    bar.style.width = `${(val / max) * 100}%`;
  }
}

function switchTab(tabName) {
  const views = ['dash', 'terminal', 'node'];
  views.forEach(view => {
    const page = document.getElementById(`view-${view}`);
    const nav = document.getElementById(`nav-${view}`);
    if (page && nav) {
      page.classList.toggle('hidden', view !== tabName);
      nav.classList.toggle('active', view === tabName);
    }
  });
}

function updateSessionDropdown() {
  const select = document.getElementById('session-select');
  if (!select) return;
  select.innerHTML = '';
  Object.keys(sessions).forEach(id => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.innerText = sessions[id].name;
    opt.selected = (id === currentSessionId);
    select.appendChild(opt);
  });
}

function createNewSession() {
  const newId = 'session_' + Date.now();
  sessions[newId] = { name: `Session ${Object.keys(sessions).length + 1}`, messages: [] };
  currentSessionId = newId;
  saveSessions();
  updateSessionDropdown();
  loadCurrentSession();
  logSystem(`Created and switched to ${sessions[newId].name}`);
}

function switchSession(sessionId) {
  if (!sessions[sessionId]) return;
  currentSessionId = sessionId;
  loadCurrentSession();
  logSystem(`Switched to ${sessions[sessionId].name}`);
}

function loadCurrentSession() {
  const chatOutput = document.getElementById('chat-thread');
  if (!chatOutput) return;
  chatOutput.innerHTML = '';
  const activeMessages = sessions[currentSessionId].messages;

  if (activeMessages.length === 0) {
    addChatMessage('PG1.Agent', 'PG1 initialized. Ready for commands.', 'ai-msg', false);
  } else {
    activeMessages.forEach(msg => addChatMessage(msg.sender, msg.text, msg.className, false));
  }
}

function saveSessions() { 
  localStorage.setItem('pg1_sessions', JSON.stringify(sessions)); 
}

async function sendCommand() {
  const input = document.getElementById('user-input');
  const text = input.value.trim();
  if (!text) return;

  if (text === '/reset') {
    localStorage.removeItem('pg1_sessions');
    sessions = { 'session_default': { name: 'Session 1', messages: [] } };
    currentSessionId = 'session_default';
    updateSessionDropdown();
    loadCurrentSession();
    input.value = '';
    logSystem('Cache and history wiped successfully.');
    return;
  }

  addChatMessage('User', text, 'user-msg');
  logSystem(`Sending payload: "${text}"`);
  input.value = '';

  try {
    const response = await fetch(CLOUDFLARE_WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text })
    });
    const rawText = await response.text();
    let agentReply = null;
    try { 
      agentReply = JSON.parse(rawText).response; 
    } catch { 
      agentReply = rawText; 
    }
    
    addChatMessage('PG1.Agent', agentReply || "Invalid response format", 'ai-msg');
    logSystem('Live execution response received.');
  } catch (err) {
    logSystem(`Connection Failed: ${err.message}`);
  }
}

function handleKeyPress(e) { 
  if (e.key === 'Enter') sendCommand(); 
}

function addChatMessage(sender, text, className, save = true) {
  const chatOutput = document.getElementById('chat-thread');
  if (!chatOutput) return;
  const msgDiv = document.createElement('div');
  msgDiv.className = `msg ${className}`;
  msgDiv.innerHTML = `<strong>${sender}:</strong> ${text}`;
  chatOutput.appendChild(msgDiv);
  chatOutput.scrollTop = chatOutput.scrollHeight;

  if (save && sessions[currentSessionId]) {
    sessions[currentSessionId].messages.push({ sender, text, className });
    saveSessions();
  }
}

function logSystem(text) {
  const logOutput = document.getElementById('terminal-logs');
  if (!logOutput) return;
  const logDiv = document.createElement('div');
  logDiv.innerText = `> ${text}`;
  logOutput.appendChild(logDiv);
  logOutput.scrollTop = logOutput.scrollHeight;
}

function copyLogs() {
  const logs = document.getElementById('terminal-logs');
  if (logs) navigator.clipboard.writeText(logs.innerText);
}

function clearLogs() {
  const logs = document.getElementById('terminal-logs');
  if (logs) logs.innerHTML = '<div>> Logs cleared.</div>';
}

function toggleVideo() {
  const btn = document.getElementById('btn-video');
  const container = document.getElementById('video-container');
  if (btn && container) {
    const isHidden = container.classList.toggle('hidden');
    btn.innerText = `Video: ${isHidden ? 'OFF' : 'ON'}`;
  }
}

function toggleAudio() {
  const btn = document.getElementById('btn-audio');
  if (btn) {
    const isOff = btn.innerText.includes('OFF');
    btn.innerText = `Audio: ${isOff ? 'ON' : 'OFF'}`;
  }
}

function toggleVoice() {
  const btn = document.getElementById('btn-voice');
  if (btn) {
    const isOff = btn.innerText.includes('OFF');
    btn.innerText = `Voice: ${isOff ? 'ON' : 'OFF'}`;
  }
}
