// Global State Configuration
let recognition = null;
let isVoiceActive = false;
let isAudioOutputEnabled = true;
let currentStream = null;
let facingMode = "environment";

// Set this to your live Cloudflare Worker URL
const WORKER_PROXY_URL = "https://your-worker-subdomain.workers.dev";

const terminal = document.getElementById('terminal');
const micStatus = document.getElementById('micStatus');
const voiceToggleBtn = document.getElementById('voiceToggleBtn');
const speechOutputBtn = document.getElementById('speechOutputBtn');
const videoElement = document.getElementById('webcam');
const frameCanvas = document.getElementById('frameCanvas');

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
    logTerminal("Camera Error: Media Devices API not available.");
    return;
  }

  if (currentStream) {
    currentStream.getTracks().forEach(track => track.stop());
  }

  try {
    const constraints = {
      video: { facingMode: facingMode, width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false
    };
    currentStream = await navigator.mediaDevices.getUserMedia(constraints);
    videoElement.srcObject = currentStream;
    logTerminal(`Camera initialized (${facingMode} feed active).`);
  } catch (err) {
    logTerminal(`Camera Access Error: ${err.message}`);
  }
}

function toggleCamera() {
  facingMode = (facingMode === "user") ? "environment" : "user";
  initCamera();
}

function captureFrame() {
  if (!videoElement || !currentStream || videoElement.readyState !== 4) {
    return null;
  }
  frameCanvas.width = videoElement.videoWidth;
  frameCanvas.height = videoElement.videoHeight;
  const ctx = frameCanvas.getContext('2d');
  ctx.drawImage(videoElement, 0, 0, frameCanvas.width, frameCanvas.height);
  return frameCanvas.toDataURL('image/jpeg', 0.7);
}

function toggleAudioOutput() {
  isAudioOutputEnabled = !isAudioOutputEnabled;
  if (speechOutputBtn) {
    if (isAudioOutputEnabled) {
      speechOutputBtn.textContent = "Audio: ON";
      speechOutputBtn.style.backgroundColor = "#10b981";
      logTerminal("System Mode: Audio output ENABLED.");
    } else {
      speechOutputBtn.textContent = "Audio: OFF";
      speechOutputBtn.style.backgroundColor = "#64748b";
      logTerminal("System Mode: Text-only (Audio output DISABLED).");
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    }
  }
}

function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    logTerminal("ERROR: Speech Recognition not supported in this browser.");
    return null;
  }

  const rec = new SpeechRecognition();
  rec.continuous = false;
  rec.interimResults = false;
  rec.lang = 'en-US';

  rec.onstart = () => {
    if (micStatus) micStatus.classList.add('recording');
    logTerminal("Live audio stream initialized (Microphone).");
  };

  rec.onresult = (event) => {
    const transcript = event.results[event.results.length - 1][0].transcript.trim();
    if (transcript.length > 0) {
      logTerminal(`User (Voice): ${transcript}`);
      processUserCommand(transcript);
    }
  };

  rec.onerror = (event) => {
    if (event.error !== 'aborted') {
      logTerminal(`STT Error: ${event.error}`);
    }
  };

  rec.onend = () => {
    if (isVoiceActive) {
      setTimeout(() => {
        try {
          if (recognition && isVoiceActive) recognition.start();
        } catch (e) {}
      }, 300);
    } else {
      if (micStatus) micStatus.classList.remove('recording');
      logTerminal("Audio stream disconnected.");
    }
  };

  return rec;
}

function toggleVoice() {
  if (!recognition) {
    recognition = initSpeechRecognition();
  }

  if (!recognition) return;

  isVoiceActive = !isVoiceActive;

  if (isVoiceActive) {
    if (voiceToggleBtn) {
      voiceToggleBtn.textContent = "Voice: ON";
      voiceToggleBtn.style.backgroundColor = "#dc2626";
    }
    try {
      recognition.start();
    } catch (e) {}
  } else {
    if (voiceToggleBtn) {
      voiceToggleBtn.textContent = "Voice: OFF";
      voiceToggleBtn.style.backgroundColor = "#0284c7";
    }
    try {
      recognition.stop();
    } catch (e) {}
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
    const payload = {
      prompt: promptText,
      image: imageFrame
    };

    const response = await fetch(WORKER_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) throw new Error(`HTTP Error ${response.status}`);

    const data = await response.json();
    const reply = data.reply || "Request processed.";

    logTerminal(`Agent: ${reply}`);

    if (isAudioOutputEnabled) {
      speakAgentResponse(reply);
    }
  } catch (error) {
    logTerminal(`Agent Error: ${error.message}`);
    const fallbackReply = "Unable to process request via Cloudflare AI worker.";
    logTerminal(`Agent: ${fallbackReply}`);
    if (isAudioOutputEnabled) speakAgentResponse(fallbackReply);
  }
}

function speakAgentResponse(text) {
  if (!('speechSynthesis' in window)) {
    logTerminal("ERROR: Speech synthesis not available.");
    return;
  }

  if (recognition) {
    try { recognition.stop(); } catch (e) {}
  }

  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.95;
  utterance.pitch = 0.9;

  const voices = window.speechSynthesis.getVoices();
  const maleVoiceNames = ['Daniel', 'Oliver', 'Arthur', 'Aaron', 'Rishi', 'Fred', 'Alex', 'Male'];
  
  const selectedVoice = voices.find(v => 
    v.lang.startsWith('en') && 
    maleVoiceNames.some(name => v.name.includes(name))
  ) || voices.find(v => v.lang.startsWith('en'));

  if (selectedVoice) {
    utterance.voice = selectedVoice;
  }

  utterance.onstart = () => {
    logTerminal("Playing audio output...");
  };

  utterance.onend = () => {
    if (isVoiceActive && recognition) {
      setTimeout(() => {
        try {
          if (isVoiceActive) recognition.start();
        } catch (e) {}
      }, 300);
    }
  };

  utterance.onerror = (e) => {
    logTerminal(`Speech Error: ${e.error}`);
    if (isVoiceActive && recognition) {
      try { recognition.start(); } catch (err) {}
    }
  };

  window.speechSynthesis.speak(utterance);
}

window.addEventListener('DOMContentLoaded', () => {
  initCamera();
  if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = () => {
      window.speechSynthesis.getVoices();
    };
  }
});
