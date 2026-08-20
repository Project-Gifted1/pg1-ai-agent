// Global State
let recognition = null;
let isVoiceActive = false;
let isAudioOutputEnabled = true; // Audio response toggle

const terminal = document.getElementById('terminal');
const micStatus = document.getElementById('micStatus');
const voiceToggleBtn = document.getElementById('voiceToggleBtn');
const speechOutputBtn = document.getElementById('speechOutputBtn');

// Helper to log formatted timestamp messages to the terminal view
function logTerminal(message) {
  if (!terminal) return;
  const now = new Date().toTimeString().split(' ')[0];
  const logEntry = document.createElement('div');
  logEntry.textContent = `> [${now}]: ${message}`;
  terminal.appendChild(logEntry);
  terminal.scrollTop = terminal.scrollHeight;
}

// Toggle Speech Output On/Off (Text-Only Mode vs Speech Mode)
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

// Initialize Speech Recognition (STT)
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

// Toggle Voice Listening Mode
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

// Process Typed Text Input
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

// Direct Command Processing Engine
function processUserCommand(promptText) {
  let reply = "";
  const lower = promptText.toLowerCase();

  if (lower.includes("how do i type") || lower.includes("how to type")) {
    reply = "You can tap the input field at the bottom right, enter your command, and press Execute.";
  } else if (lower.includes("can you hear me") || lower.includes("can you speak") || lower.includes("hello")) {
    reply = "I can hear you clearly and my systems are online.";
  } else if (lower.includes("status")) {
    reply = "All system nodes are active and operating normally.";
  } else {
    reply = "Standing by for your command.";
  }

  // Print text directly into terminal console
  logTerminal(`Agent: ${reply}`);
  
  // Speak response out loud only if Audio Output is ON
  if (isAudioOutputEnabled) {
    speakAgentResponse(reply);
  }
}

// Natural Male Voice Output (TTS)
function speakAgentResponse(text) {
  if (!('speechSynthesis' in window)) {
    logTerminal("ERROR: Speech synthesis not available.");
    return;
  }

  // Release microphone audio stream temporarily for iOS hardware playback
  if (recognition) {
    try { recognition.stop(); } catch (e) {}
  }

  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.95;
  utterance.pitch = 0.9;

  const voices = window.speechSynthesis.getVoices();

  // Specifically select natural English male voices available on iOS / Web Speech
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

// Pre-load iOS voices on initial interaction
if ('speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = () => {
    window.speechSynthesis.getVoices();
  };
}
