const CLOUDFLARE_WORKER_URL = 'https://pg1-agent-worker.gnfcw9w5rk.workers.dev';

let currentSessionId = 'session_default';
let sessions = JSON.parse(localStorage.getItem('pg1_sessions')) || {
  'session_default': { name: 'Session 1', messages: [] }
};

document.addEventListener('DOMContentLoaded', () => {
  updateSessionDropdown();
  loadCurrentSession();
});

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
}

function switchSession(sessionId) {
  if (!sessions[sessionId]) return;
  currentSessionId = sessionId;
  loadCurrentSession();
}

function loadCurrentSession() {
  const chatOutput = document.getElementById('chat-thread');
  if (!chatOutput) return;
  chatOutput.innerHTML = '';
  const activeMessages = sessions[currentSessionId].messages;

  if (activeMessages.length === 0) {
    addChatMessage('PG1.Agent', 'PG1 System Initialized. Direct Google AI Studio tunnel active.', 'ai-msg', false);
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
    return;
  }

  addChatMessage('User', text, 'user-msg');
  input.value = '';

  try {
    const response = await fetch(`${CLOUDFLARE_WORKER_URL}?nocache=${Date.now()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text })
    });
    
    const data = await response.json();
    addChatMessage('PG1.Agent', data.response || "No response received", 'ai-msg');
  } catch (err) {
    addChatMessage('PG1.Agent', `Connection Failed: ${err.message}`, 'ai-msg');
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
