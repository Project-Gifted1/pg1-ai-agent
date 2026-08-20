// Persistent Global Audio State
let recognition = null;
let isVoiceActive = false;

const terminal = document.getElementById('terminal');
const micStatus = document.getElementById('micStatus');
const voiceToggleBtn = document.getElementById('voiceToggleBtn');

// Helper to log formatted timestamp messages
function logTerminal(message) {
  if (!terminal) return;
  const now = new Date().toTimeString().split(' ')[0];
  const logEntry = document.createElement('div');
  logEntry.textContent = `> [${now}]: ${message}`;
  terminal.appendChild(logEntry);
  terminal.scrollTop = terminal.scrollHeight;
}

// Unlock iOS Audio Session on Button Tap
function unlockAudioSession() {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
    const silentUtterance = new SpeechSynthesisUtterance('');
    silentUtterance.volume = 0;
    window.speechSynthesis.speak(silentUtterance);
  }
}

// Initialize Speech Recognition Engine
function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    logTerminal("ERROR: Speech Recognition API not supported in this browser.");
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

// Main Toggle Function
function toggleVoice() {
  unlockAudioSession();

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
    } catch (e) {}
  } else {
    voiceToggleBtn.textContent = "Voice: OFF";
    voiceToggleBtn.style.backgroundColor = "#0284c7";
    try {
      recognition.stop();
    } catch (e) {}
  }
}

// Manual Text Execution
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

// Process Command
function processUserCommand(promptText) {
  let reply = "";
  const lower = promptText.toLowerCase();

  if (lower.includes("can you hear me") || lower.includes("can you speak") || lower.includes("hello") || lower.includes("i can't hear you")) {
    reply = "I can hear you clearly and my voice output is working.";
  } else if (lower.includes("status")) {
    reply = "All system nodes are active.";
  } else {
    reply = `Command received: ${promptText}. Processing request.`;
  }

  logTerminal(`Agent: ${reply}`);
  speakAgentResponse(reply);
}

// Text-to-Speech Output
function speakAgentResponse(text) {
  if (!('speechSynthesis' in window)) {
    logTerminal("ERROR: Speech Synthesis not supported.");
    return;
  }

  if (recognition) {
    try {
      recognition.stop();
    } catch (e) {}
  }

  window.speechSynthesis.cancel();

  setTimeout(() => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

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
      logTerminal(`TTS Error: ${e.error}`);
      if (isVoiceActive && recognition) {
        try { recognition.start(); } catch (err) {}
      }
    };

    window.speechSynthesis.speak(utterance);
  }, 200);
}
