let videoActive = false;
let audioActive = false;
let voiceActive = false;
let mediaStream = null;
let selectedVoice = null;

// Initialize natural sounding voices for mobile/Safari
function loadNaturalVoice() {
    if ('speechSynthesis' in window) {
        const voices = window.speechSynthesis.getVoices();
        selectedVoice = voices.find(v => v.lang.startsWith('en') && (v.name.includes('Natural') || v.name.includes('Enhanced') || v.name.includes('Siri') || v.name.includes('Google'))) ||
                        voices.find(v => v.lang.startsWith('en')) ||
                        voices[0];
    }
}

if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = loadNaturalVoice;
    loadNaturalVoice();
}

async function toggleVideo() {
    const btn = document.getElementById('btn-video');
    const container = document.getElementById('video-container');
    const video = document.getElementById('webcam-preview');

    if (!videoActive) {
        try {
            mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: audioActive });
            video.srcObject = mediaStream;
            container.classList.remove('hidden');
            videoActive = true;
            btn.innerText = "Video: ON";
            logSystem("Video stream enabled.");
        } catch (err) {
            logSystem("Camera error: " + err.message);
        }
    } else {
        stopStreams();
        container.classList.add('hidden');
        videoActive = false;
        btn.innerText = "Video: OFF";
        logSystem("Video stream disabled.");
    }
}

function toggleAudio() {
    const btn = document.getElementById('btn-audio');
    audioActive = !audioActive;
    btn.innerText = audioActive ? "Audio: ON" : "Audio: OFF";
    logSystem(`Microphone input ${audioActive ? "enabled" : "disabled"}.`);
}

function toggleVoice() {
    const btn = document.getElementById('btn-voice');
    voiceActive = !voiceActive;
    btn.innerText = voiceActive ? "Voice: ON" : "Voice: OFF";
    
    // Unlock speech engine on iOS tap
    if (voiceActive && 'speechSynthesis' in window) {
        window.speechSynthesis.resume();
        speakResponse("Voice output enabled.");
    }
    logSystem(`Text-to-speech output ${voiceActive ? "enabled" : "disabled"}.`);
}

function stopStreams() {
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }
}

function handleKeyPress(event) {
    if (event.key === 'Enter') {
        sendCommand();
    }
}

function sendCommand() {
    const input = document.getElementById('user-input');
    const text = input.value.trim();
    if (!text) return;

    addChatMessage('User', text, 'user-msg');
    logSystem(`Executed command: ${text}`);

    input.value = '';

    setTimeout(() => {
        const responseText = `Received command "${text}". Operations running.`;
        addChatMessage('PG1 Agent', responseText, 'ai-msg');
        logSystem(`Agent response generated.`);

        if (voiceActive) {
            speakResponse(responseText);
        }
    }, 500);
}

function speakResponse(text) {
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        
        if (!selectedVoice) loadNaturalVoice();
        if (selectedVoice) utterance.voice = selectedVoice;
        
        utterance.rate = 1.0;
        utterance.pitch = 1.0;
        
        window.speechSynthesis.speak(utterance);
    }
}

function addChatMessage(sender, text, className) {
    const chatOutput = document.getElementById('chat-thread');
    const msgDiv = document.createElement('div');
    msgDiv.className = `msg ${className}`;
    msgDiv.innerHTML = `<strong>${sender}:</strong> ${text}`;
    chatOutput.appendChild(msgDiv);
    chatOutput.scrollTop = chatOutput.scrollHeight;
}

function logSystem(text) {
    const logOutput = document.getElementById('terminal-logs');
    const logDiv = document.createElement('div');
    logDiv.innerText = `> ${text}`;
    logOutput.appendChild(logDiv);
    logOutput.scrollTop = logOutput.scrollHeight;
}

function copyLogs() {
    const logs = document.getElementById('terminal-logs').innerText;
    navigator.clipboard.writeText(logs);
    alert('Logs copied to clipboard.');
}

function clearLogs() {
    document.getElementById('terminal-logs').innerHTML = '<div>> Logs cleared.</div>';
}
