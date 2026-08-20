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

// Initialize Speech-to-Text (STT) Engine
function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    logTerminal("ERROR: Speech Recognition API not supported in this browser.");
    return null;
  }

  const rec = new SpeechRecognition();
  rec.continuous = false; // Set false for stability on iOS Safari
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
        try { recognition.start(); } catch (e) {}
      }, 300);
    } else {
      if (micStatus) micStatus.classList.remove('recording');
      logTerminal("Audio stream disconnected.");
    }
  };

  return rec;
}

// Toggle Voice Listening State
function toggleVoice() {
  if (!recognition) {
    recognition = initSpeechRecognition();
  }

  if (!recognition) return;

  isVoiceActive = !isVoiceActive;

  if (isVoiceActive) {
    voiceToggleBtn.textContent = "Voice: ON";
    voiceToggleBtn.style.backgroundColor = "#dc2626";
    try { recognition.start(); } catch (e) {}
  } else {
    voiceToggleBtn.textContent = "Voice: OFF";
    voiceToggleBtn.style.backgroundColor = "#0284c7";
    recognition.stop();
  }
}

// Client-Side Command Processing & Local Response Logic
function processUserCommand(promptText) {
  let reply = "";
  const lower = promptText.toLowerCase();

  // Simple client-side response logic
  if (lower.includes("can you hear me") || lower.includes("hello") || lower.includes("hey")) {
    reply = "Yes, I can hear you clearly. How can I assist you?";
  } else if (lower.includes("status")) {
    reply = "All system nodes are online and operating normally.";
  } else {
    reply = `Command received: "${promptText}". Processing request.`;
  }

  logTerminal(`Agent: ${reply}`);
  speakAgentResponse(reply);
}

// Client-Side Text-to-Speech Output (Browser Voice)
function speakAgentResponse(text) {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel(); // Clear remaining queue
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    utterance.onstart = () => {
      logTerminal("Playing audio output...");
    };

    window.speechSynthesis.speak(utterance);
  } else {
    logTerminal("ERROR: Browser does not support Text-To-Speech.");
  }
}
