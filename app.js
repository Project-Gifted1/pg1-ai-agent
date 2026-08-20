// Persistent Global Audio State
let recognition = null;
let isVoiceActive = false;
let systemVoice = null;

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

// Pre-load available iOS voices
function loadVoices() {
  if ('speechSynthesis' in window) {
    const voices = window.speechSynthesis.getVoices();
    // Prefer en-US native voices for iOS Safari
    systemVoice = voices.find(v => v.lang.includes('en') && v.localService) || voices[0] || null;
  }
}

if ('speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = loadVoices;
  loadVoices();
}

// Unlock iOS Audio Session on explicit user interaction (Tap)
function unlockAudioSession() {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel(); // Clear any pending queued state
    const silentUtterance = new SpeechSynthesisUtterance('');
    silentUtterance.volume = 0;
    window.speechSynthesis.speak(silentUtterance);
  }
}

// Initialize Speech-to-Text (STT) Engine
function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    logTerminal("ERROR: Speech Recognition API not supported in this browser.");
    return null;
  }

  const rec = new SpeechRecognition();
  rec.continuous = false; // Set to false for iOS Safari audio stability
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

// Toggle Audio Listening (Acts as the user gesture trigger)
function toggleVoice() {
  // Direct gesture unlock for iOS Safari
  unlockAudioSession();

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

// Process Command & Generate Spoken Reply
function processUserCommand(promptText) {
  let reply = "";
  const lower = promptText.toLowerCase();

  if (lower.includes("can you hear me") || lower.includes("can you speak") || lower.includes("hello")) {
    reply = "I can hear you clearly and my voice output is working properly.";
  } else if (lower.includes("status")) {
    reply = "All nodes are active and functioning normally.";
  } else {
    reply = `Command received: ${promptText}. System request processed.`;
  }

  logTerminal(`Agent: ${reply}`);
  speakAgentResponse(reply);
}

// Fixed Text-to-Speech Output (iOS Safari Compatible)
function speakAgentResponse(text) {
  if (!('speechSynthesis' in window)) {
    logTerminal("ERROR: Speech Synthesis not supported.");
    return;
  }

  // Force cancel pending or stuck queue on iOS Safari
  window.speechSynthesis.cancel();

  setTimeout(() => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    // Explicitly assign system voice if loaded
    if (systemVoice) {
      utterance.voice = systemVoice;
    }

    utterance.onstart = () => {
      logTerminal("Playing audio output...");
    };

    utterance.onerror = (e) => {
      logTerminal(`TTS Playback Error: ${e.error}`);
    };

    window.speechSynthesis.speak(utterance);
  }, 100);
}
