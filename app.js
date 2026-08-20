// Process Command & Trigger Clean Text-to-Speech Output
function processUserCommand(promptText) {
  let reply = "";
  const lower = promptText.toLowerCase();

  if (lower.includes("can you hear me") || lower.includes("can you speak") || lower.includes("hello") || lower.includes("i can't hear you")) {
    reply = "I can hear you clearly now. Audio playback is active.";
  } else if (lower.includes("status")) {
    reply = "All nodes are running normally.";
  } else {
    reply = `Command received: ${promptText}. Processing request.`;
  }

  logTerminal(`Agent: ${reply}`);
  speakAgentResponse(reply);
}

// Fixed Text-to-Speech Output for iOS Safari
function speakAgentResponse(text) {
  if (!('speechSynthesis' in window)) {
    logTerminal("ERROR: Speech Synthesis not supported.");
    return;
  }

  // STEP 1: Temporarily stop mic capture so iOS unmutes system audio
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

    // STEP 2: Restart microphone listening only AFTER agent finishes speaking
    utterance.onend = () => {
      if (isVoiceActive && recognition) {
        setTimeout(() => {
          try {
            recognition.start();
          } catch (e) {}
        }, 300);
      }
    };

    utterance.onerror = (e) => {
      logTerminal(`TTS Playback Error: ${e.error}`);
      // Restart mic if speech fails
      if (isVoiceActive && recognition) {
        try { recognition.start(); } catch (err) {}
      }
    };

    window.speechSynthesis.speak(utterance);
  }, 200);
}
