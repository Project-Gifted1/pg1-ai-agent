// Persistent Global Audio State
let recognition = null;
let isVoiceActive = false;
const terminal = document.getElementById('terminal');
const micStatus = document.getElementById('micStatus');
const voiceToggleBtn = document.getElementById('voiceToggleBtn');

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
  rec.continuous = true;
  rec.interimResults = false;
  rec.lang = 'en-US';

  rec.onstart = () => {
    micStatus.classList.add('recording');
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
    logTerminal(`STT Error: ${event.error}`);
  };

  rec.onend = () => {
    // Keep session active if toggle is ON (handles iOS WebKit background drops)
    if (isVoiceActive) {
      rec.start();
    } else {
      micStatus.classList.remove('recording');
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
    voiceToggleBtn.classList.add('active');
    recognition.start();
  } else {
    voiceToggleBtn.textContent = "Voice: OFF";
    voiceToggleBtn.classList.remove('active');
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
    // Send clean payload to backend endpoint
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: promptText })
    });

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
    window.speechSynthesis.cancel(); // Clear previous queue
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    utterance.onstart = () => {
      logTerminal("Playing audio output...");
    };

    window.speechSynthesis.speak(utterance);
  }
}
