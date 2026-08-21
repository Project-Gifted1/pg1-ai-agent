const WORKER_URL = 'https://pg1-agent-worker.gnfcw9w5rk.workers.dev';
const STORAGE_KEY = 'pg1_sessions_v3'; // Bumped storage version to purge legacy error logs

let currentSessionId = 'session_default';
let sessions = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {
  'session_default': { name: 'Session 1', messages: [] }
};

let videoActive = false;
let audioActive = false;
let voiceOutput = false;
let mediaStream = null;
let speechRecognition = null;

document.addEventListener('DOMContentLoaded', () => {
  updateSessionDropdown();
  loadCurrentSession();
  initSpeechRecognition();
});

// Tab Navigation
function showTab(tabName, el) {
  document.querySelectorAll('.tab-view').forEach(view => view.classList.remove('active-view'));
  document.querySelectorAll('.nav-item').forEach(btn => btn.classList.remove('active'));
  document.getElementById(`view-${tabName}`).classList.add('active-view');
  el.classList.add('active');
}

// Session Management
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

function deleteCurrentSession() {
  const keys = Object.keys(sessions);
  if (keys.length <= 1) {
    sessions['session_default'] = { name: 'Session 1', messages: [] };
    currentSessionId = 'session_default';
  } else {
    delete sessions[currentSessionId];
    currentSessionId = Object.keys(sessions)[0];
  }
  saveSessions();
  updateSessionDropdown();
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
}

// Media & Hardware Controls
async function toggleVideo() {
  const btn = document.getElementById('btn-video');
  if (!videoActive) {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: audioActive });
      const videoEl = document.getElementById('webcam-feed');
      if (videoEl) videoEl.srcObject = mediaStream;
      videoActive = true;
      btn.innerText = 'Video: ON';
      btn.classList.add('btn-active');
    } catch (err) {
      alert('Camera access denied or unavailable.');
    }
  } else {
    stopMediaTracks('video');
    videoActive = false;
    btn.innerText = 'Video: OFF';
    btn.classList.remove('btn-active');
  }
}

async function toggleAudio() {
  const btn = document.getElementById('btn-audio');
  if (!audioActive) {
    if (speechRecognition) {
      try {
        speechRecognition.start();
        audioActive = true;
        btn.innerText = 'Audio: ON';
        btn.classList.add('btn-active');
      } catch (e) { 
        console.error(e); 
      }
    } else {
      alert('Speech recognition not supported on this device/browser.');
    }
  } else {
    if (speechRecognition) speechRecognition.stop();
    audioActive = false;
    btn.innerText = 'Audio: OFF';
    btn.classList.remove('btn-active');
  }
}

function toggleVoice() {
  const btn = document.getElementById('btn-voice');
  voiceOutput = !voiceOutput;
  btn.innerText = voiceOutput ? 'Voice: ON' : 'Voice: OFF';
  if (voiceOutput) btn.classList.add('btn-active');
  else btn.classList.remove('btn-active');
}

function stopMediaTracks(type) {
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => {
      if (track.kind === type) track.stop();
    });
  }
}

function initSpeechRecognition() {
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (Speech) {
    speechRecognition = new Speech();
    speechRecognition.continuous = true;
    speechRecognition.interimResults = false;
    speechRecognition.onresult = (event) => {
      const transcript = event.results[event.results.length - 1][0].transcript;
      document.getElementById('user-input').value = transcript;
      sendCommand();
    };
  }
}

function captureFrame() {
  if (!videoActive) return null;
  const videoEl = document.getElementById('webcam-feed');
  if (!videoEl) return null;
  const canvas = document.createElement('canvas');
  canvas.width = videoEl.videoWidth || 320;
  canvas.height = videoEl.videoHeight || 240;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.5).split(',')[1];
}

// Command & Messaging Execution
async function sendCommand() {
  const input = document.getElementById('user-input');
  const text = input.value.trim();
  if (!text) return;

  if (text === '/reset') {
    localStorage.removeItem(STORAGE_KEY);
    sessions = { 'session_default': { name: 'Session 1', messages: [] } };
    currentSessionId = 'session_default';
    updateSessionDropdown();
    loadCurrentSession();
    input.value = '';
    return;
  }

  addChatMessage('User', text, 'user-msg');
  input.value = '';

  const imageBase64 = captureFrame();

  try {
    const response = await fetch(`${WORKER_URL}?nocache=${Date.now()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, image: imageBase64 })
    });

    const data = await response.json();
    const replyText = data.response || data.reply || "PG1 System Error: Empty response from Worker.";
    addChatMessage('PG1.Agent', replyText, 'ai-msg');

    if (voiceOutput && 'speechSynthesis' in window) {
      const utterance = new SpeechSynthesisUtterance(replyText.replace(/[*_#]/g, ''));
      window.speechSynthesis.speak(utterance);
    }
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
