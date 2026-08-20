const CLOUDFLARE_WORKER_URL = 'https://pg1-agent-worker.gnfcw9w5rk.workers.dev';

let videoActive = false;
let audioActive = false;
let voiceActive = false;
let mediaStream = null;
let recognition = null;
let selectedVoice = null;

// Multi-Session Memory State
let currentSessionId = 'session_default';
let sessions = JSON.parse(localStorage.getItem('pg1_sessions')) || {
    'session_default': { name: 'Session 1', messages: [] }
};

// Initialize App State
document.addEventListener('DOMContentLoaded', () => {
    updateSessionDropdown();
    loadCurrentSession();
});

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

// Session Management Engine
function updateSessionDropdown() {
    const select = document.getElementById('session-select');
    if (!select) return;
    select.innerHTML = '';
    
    Object.keys(sessions).forEach(id => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.innerText = sessions[id].name;
        if (id === currentSessionId) opt.selected = true;
        select.appendChild(opt);
    });
}

function createNewSession() {
    const newId = 'session_' + Date.now();
    const count = Object.keys(sessions).length + 1;
    sessions[newId] = { name: `Session ${count}`, messages: [] };
    currentSessionId = newId;
    saveSessions();
    updateSessionDropdown();
    loadCurrentSession();
    logSystem(`Created and switched to ${sessions[newId].name}`);
}

function switchSession(sessionId) {
    if (!sessions[sessionId]) return;
    currentSessionId = sessionId;
    loadCurrentSession();
    logSystem(`Switched to ${sessions[sessionId].name}`);
}

function loadCurrentSession() {
    const chatOutput = document.getElementById('chat-thread');
    chatOutput.innerHTML = '';
    const activeMessages = sessions[currentSessionId].messages;

    if (activeMessages.length === 0) {
        addChatMessage('PG1.Agent', 'Hello! PG1.Agent online. How can I assist you today?', 'ai-msg', false);
    } else {
        activeMessages.forEach(msg => {
            addChatMessage(msg.sender, msg.text, msg.className, false);
        });
    }
}

function saveSessions() {
    localStorage.setItem('pg1_sessions', JSON.stringify(sessions));
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
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    
    const utterance = new SpeechSynthesisUtterance(text);
    if (!selectedVoice) initVoices();
    if (selectedVoice) utterance.voice = selectedVoice;

    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    window.speechSynthesis.speak(utterance);
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
                logSystem("Microphone active. Listening...");
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

// Resilient API Dispatch & Communication Logic
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

        const rawData = await response.text();
        let data;

        try {
            data = JSON.parse(rawData);
        } catch (e) {
            data = { response: rawData };
        }

        const agentReply = data.response || data.text || data.result || data.message || (typeof data === 'string' ? data : null);

        if (agentReply) {
            addChatMessage('PG1.Agent', agentReply, 'ai-msg');
            logSystem('Live execution response received.');

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

// UI Utilities & Thread Persistence
function addChatMessage(sender, text, className, save = true) {
    const chatOutput = document.getElementById('chat-thread');
    const msgDiv = document.createElement('div');
    msgDiv.className = `msg ${className}`;
    msgDiv.innerHTML = `<strong>${sender}:</strong> ${text}`;
    chatOutput.appendChild(msgDiv);
    chatOutput.scrollTop = chatOutput.scrollHeight;

    if (save && sessions[currentSessionId]) {
        sessions[currentSessionId].messages.push({ sender, text, className });
        saveSessions();
    }
}

function logSystem(text) {
    const logOutput = document.getElementById('terminal-logs');
    if (!logOutput) return;
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
