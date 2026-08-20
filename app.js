// Persistent Global Audio State
let recognition = null;
let isVoiceActive = false;
const terminal = document.getElementById('terminal');
const micStatus = document.getElementById('micStatus');
const voiceToggleBtn = document.getElementById('voiceToggleBtn');

// SET YOUR BACKEND URL HERE (e.g., your VPS/DigitalOcean backend server)
const BACKEND_API_URL = "https://your-backend-domain.com/api/chat";

// Helper to log formatted timestamp messages
function logTerminal(message) {
  const now = new Date().toTimeString().split(' ')[0];
  const logEntry = document.createElement('div');
  logEntry.textContent = `> [${now}]: ${message}`;
  terminal.appendChild(logEntry);
  terminal.scrollTop = terminal.scrollHeight;
}

// Initialize STT Engine
function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    logTerminal("ERROR: Speech Recognition API not supported in this browser.");
    return null;
  }

  const rec = new SpeechRecognition();
  rec.continuous = false; // Set to false for iOS WebKit stability
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
    // Ignore routine iOS aborts during restart cycle
    if (event.error !== 'aborted') {
      logTerminal(`STT Error: ${event.error}`);
    }
  };

  rec.onend = () => {
    // Re-arm recognition loop on iOS if Voice is still toggled ON
    if (isVoiceActive) {
      setTimeout(() => {
        try {
          rec.start();
        } catch (e) {
          // Sink active start exceptions
        }
      }, 300);
    } else {
      if (micStatus) micStatus.classList.remove('recording');
      logTerminal("Audio stream disconnected.");
    }
  };

  return rec;
}

// Toggle Audio Listening
function toggleVoice() {
  if (!recognition) {
    recognition = initSpeechRecognition();
  }

  if (!recognition) return;

  isVoiceActive = !isVoiceActive;

  if (isVoiceActive) {
    voiceToggleBtn.textContent = "Voice: ON";
    voiceToggleBtn.style.backgroundColor = "#dc2626";
    try {
      recognition.start();
    } catch (e) {
      // Handles cases where engine was already active
    }
  } else {
    voiceToggleBtn.textContent = "Voice: OFF";
    voiceToggleBtn.style.backgroundColor = "#0284c7";
    recognition.stop();
  }
}

// Manual Text Fallback Execution
function handleManualSend() {
  const input = document.getElementById('cmdInput');
  const text = input.value.trim();
  if (text) {
    logTerminal(`User (Text): ${text}`);
    processUserCommand(text);
    input.value = '';
  }
}

// Process Command & Trigger Clean Text-to-Speech Output
async function processUserCommand(promptText) {
  try {
    // Determine target URL: use explicit backend URL if hosted on GitHub Pages
    const endpoint = window.location.hostname.includes('github.io') 
      ? BACKEND_API_URL 
      : '/api/chat';

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: promptText })
    });

    if (!response.ok) {
      throw new Error(`HTTP Error status: ${response.status}`);
    }

    const data = await response.json();
    const reply = data.reply || "Command received.";

    logTerminal(`Agent: ${reply}`);
    speakAgentResponse(reply);

  } catch (err) {
    logTerminal(`Execution Error: Failed to reach agent endpoint.`);
  }
}

// Synthesize Text-to-Speech Output
function speakAgentResponse(text) {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    utterance.onstart = () => {
      logTerminal("Playing audio output...");
    };

    window.speechSynthesis.speak(utterance);
  }
}
