let recognition = null;
let isVoiceActive = false;
let isAudioOutputEnabled = true;
let currentStream = null;
let facingMode = "environment";

// Set to your Cloudflare Worker URL
const WORKER_PROXY_URL = "https://your-worker-subdomain.workers.dev";

const terminal = document.getElementById('terminal');
const voiceToggleBtn = document.getElementById('voiceToggleBtn');
const speechOutputBtn = document.getElementById('speechOutputBtn');
const frameCanvas = document.getElementById('frameCanvas');

function switchTab(tabName) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));

  document.getElementById(`tab${tabName}`).classList.add('active');
  document.getElementById(`nav${tabName}`).classList.add('active');

  // Attach camera stream to current active video tag
  attachStreamToVideo();
}

function logTerminal(message) {
  if (!terminal) return;
  const now = new Date().toTimeString().split(' ')[0];
  const logEntry = document.createElement('div');
  logEntry.textContent = `> [${now}]: ${message}`;
  terminal.appendChild(logEntry);
  terminal.scrollTop = terminal.scrollHeight;
}

async function initCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    logTerminal("Camera Error: Media devices unavailable.");
    return;
  }

  if (currentStream) {
    currentStream.getTracks().forEach(track => track.stop());
  }

  try {
    currentStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facingMode, width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false
    });
    attachStreamToVideo();
    logTerminal(`Camera initialized (${facingMode} feed active).`);
  } catch (err) {
    logTerminal(`Camera Access Error: ${err.message}`);
  }
}

function attachStreamToVideo() {
  const dashVideo = document.getElementById('webcamDash');
  const termVideo = document.getElementById('webcamTerm');
  if (dashVideo) dashVideo.srcObject = currentStream;
  if (termVideo) termVideo.srcObject = currentStream;
}

function toggleCamera() {
  facingMode = (facingMode === "user") ? "environment" : "user";
  initCamera();
}

function captureFrame() {
  const activeVideo = document.getElementById('webcamTerm') || document.getElementById('webcamDash');
  if (!activeVideo || !currentStream || activeVideo.readyState !== 4) return null;
  
  frameCanvas.width = activeVideo.videoWidth;
  frameCanvas.height = activeVideo.videoHeight;
  const ctx = frameCanvas.getContext('2d');
  ctx.drawImage(activeVideo, 0, 0, frameCanvas.width, frameCanvas.height);
  return frameCanvas.toDataURL('image/jpeg', 0.7);
}

function toggleAudioOutput() {
  isAudioOutputEnabled = !isAudioOutputEnabled;
  if (speechOutputBtn) {
    speechOutputBtn.textContent = isAudioOutputEnabled ? "Audio: ON" : "Audio: OFF";
    speechOutputBtn.style.backgroundColor = isAudioOutputEnabled ? "#10b981" : "#64748b";
    logTerminal(isAudioOutputEnabled ? "System Mode: Audio output ENABLED." : "System Mode: Text-only (Audio output DISABLED).");
  }
}

function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    logTerminal("ERROR: Speech Recognition unsupported.");
    return null;
  }

  const rec = new SpeechRecognition();
  rec.continuous = false;
  rec.interimResults = false;
  rec.lang = 'en-US';

  rec.onstart = () => logTerminal("Live audio stream initialized (Microphone).");

  rec.onresult = (event) => {
    const transcript = event.results[event.results.length - 1][0].transcript.trim();
    if (transcript.length > 0) {
      logTerminal(`User (Voice): ${transcript}`);
      processUserCommand(transcript);
    }
  };

  rec.onerror = (event) => {
    if (event.error !== 'aborted') logTerminal(`STT Error: ${event.error}`);
  };

  rec.onend = () => {
    if (isVoiceActive) {
      setTimeout(() => { try { if (recognition && isVoiceActive) recognition.start(); } catch(e){} }, 300);
    } else {
      logTerminal("Audio stream disconnected.");
    }
  };

  return rec;
}

function toggleVoice() {
  if (!recognition) recognition = initSpeechRecognition();
  if (!recognition) return;

  isVoiceActive = !isVoiceActive;

  if (isVoiceActive) {
    if (voiceToggleBtn) {
      voiceToggleBtn.textContent = "Voice: ON";
      voiceToggleBtn.style.backgroundColor = "#dc2626";
    }
    try { recognition.start(); } catch(e){}
  } else {
    if (voiceToggleBtn) {
      voiceToggleBtn.textContent = "Voice: OFF";
      voiceToggleBtn.style.backgroundColor = "#0284c7";
    }
    try { recognition.stop(); } catch(e){}
  }
}

function handleManualSend() {
  const input = document.getElementById('cmdInput');
  if (!input) return;
  const text = input.value.trim();
  if (text) {
    logTerminal(`User (Text): ${text}`);
    processUserCommand(text);
    input.value = '';
  }
}

async function processUserCommand(promptText) {
  const imageFrame = captureFrame();

  try {
    const response = await fetch(WORKER_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: promptText, image: imageFrame })
    });

    const data = await response.json();
    const reply = data.reply || "Request processed.";

    logTerminal(`Agent: ${reply}`);
    if (isAudioOutputEnabled) speakAgentResponse(reply);

  } catch (error) {
    logTerminal(`Agent Error: ${error.message}`);
    const fallbackReply = "Unable to process request via Cloudflare AI worker.";
    logTerminal(`Agent: ${fallbackReply}`);
    if (isAudioOutputEnabled) speakAgentResponse(fallbackReply);
  }
}

function speakAgentResponse(text) {
  if (!('speechSynthesis' in window)) return;
  if (recognition) { try { recognition.stop(); } catch(e){} }

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.95;

  utterance.onend = () => {
    if (isVoiceActive && recognition) {
      setTimeout(() => { try { if (isVoiceActive) recognition.start(); } catch(e){} }, 300);
    }
  };

  window.speechSynthesis.speak(utterance);
}

window.addEventListener('DOMContentLoaded', () => {
  initCamera();
});
