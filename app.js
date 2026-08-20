const CLOUDFLARE_WORKER_URL = 'https://pg1-agent-worker.gnfcw9w5rk.workers.dev';

let videoActive = false;
let audioActive = false;
let voiceActive = false;
let mediaStream = null;
let recognition = null;
let selectedVoice = null;

// Navigation Tab Switcher
function switchTab(tabName) {
    const views = ['dash', 'terminal', 'node'];
    
    views.forEach(view => {
        const page = document.getElementById(`view-${view}`);
        const nav = document.getElementById(`nav-${view}`);
        
        if (view === tabName) {
            page.classList.remove('hidden');
            nav.classList.add('active');
        } else {
            page.classList.add('hidden');
            nav.classList.remove('active');
        }
    });
}

// Text-to-Speech Engine
function initVoices() {
    if ('speechSynthesis' in window) {
        let voices = window.speechSynthesis.getVoices();
        if (voices.length > 0) {
            selectedVoice = voices.find(v => v.lang.startsWith('en') && (v.name.includes('Samantha') || v.name.includes('Karen') || v.name.includes('Enhanced') || v.name.includes('Natural') || v.name.includes('Google'))) ||
                            voices.find(v => v.lang.startsWith('en')) ||
                            voices[0];
        }
    }
}

if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = initVoices;
    initVoices();
}

function speakResponse(text) {
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        if (!selectedVoice) initVoices();
        if (selectedVoice) utterance.voice = selectedVoice;
        
        utterance.rate = 1.0;
        utterance.pitch = 1.0;
        utterance.volume = 1.0;
        
        window.speechSynthesis.speak(utterance);
    }
}

// Speech-to-Text Listening Engine
function initSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        logSystem("Speech recognition not supported on this browser.");
        return;
    }

    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    recognition.onresult = (event) => {
        const transcript = event.results[event.results.length - 1][0].transcript.trim();
        if (transcript) {
            document.getElementById('user-input').value = transcript;
            sendCommand();
        }
    };

    recognition.onerror = (event) => {
        logSystem(`Microphone Error: ${event.error}`);
    };

    recognition.onend = () => {
        if (audioActive && recognition) {
            try { recognition.start(); } catch(e) {}
        }
    };
}

// Control Bar Toggles
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
            logSystem("Video stream active.");
        } catch (err) {
            logSystem("Camera access error: " + err.message);
        }
    } else {
        stopStreams();
        container.classList.add('hidden');
        videoActive = false;
        btn.innerText = "Video: OFF";
        logSystem("Video stream stopped.");
    }
}

function toggleAudio() {
    const btn = document.getElementById('btn-audio');
    audioActive = !audioActive;

    if (audioActive) {
        btn.innerText = "Audio: ON";
        if (!recognition) initSpeechRecognition();
        if (recognition) {
            try {
                recognition.start();
                logSystem("Microphone active. Listening for commands...");
            } catch (e) {
                logSystem("Mic error: " + e.message);
            }
        }
    } else {
        btn.innerText = "Audio: OFF";
        if (recognition) {
            recognition.stop();
            logSystem("Microphone deactivated.");
        }
    }
}

function toggleVoice() {
    const btn = document.getElementById('btn-voice');
    voiceActive = !voiceActive;
    btn.innerText = voiceActive ? "Voice: ON" : "Voice: OFF";
    
    if (voiceActive && 'speechSynthesis' in window) {
        window.speechSynthesis.resume();
        initVoices();
        speakResponse("Voice synthesis enabled.");
    }
    logSystem(`Voice output ${voiceActive ? "enabled" : "disabled"}.`);
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

// Send Command & Route directly to Cloudflare Worker Endpoint
async function sendCommand() {
    const input = document.getElementById('user-input');
    const text = input.value.trim();
    if (!text) return;

    addChatMessage('User', text, 'user-msg');
    logSystem(`Sending payload: "${text}"`);
    input.value = '';

    try {
        const response = await fetch(CLOUDFLARE_WORKER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text })
        });

        const data = await response.json();

        if (data.response || data.text || data.result) {
            const agentReply = data.response || data.text || data.result;
            addChatMessage('PG1.Agent', agentReply, 'ai-msg');
            logSystem('Received live execution response from PG1 Worker.');

            if (voiceActive) {
                speakResponse(agentReply);
            }
        } else {
            logSystem(`Worker Response Error: Invalid schema returned`);
        }
    } catch (err) {
        logSystem(`Connection Failed: ${err.message}`);
    }
}

// Utilities
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
