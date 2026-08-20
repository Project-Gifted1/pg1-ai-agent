let videoActive = false;
let audioActive = false;
let voiceActive = false;
let mediaStream = null;

// Toggle Camera / Video Stream
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
            logSystem("Error accessing camera: " + err.message);
        }
    } else {
        stopStreams();
        container.classList.add('hidden');
        videoActive = false;
        btn.innerText = "Video: OFF";
        logSystem("Video stream disabled.");
    }
}

// Toggle Audio Stream
function toggleAudio() {
    const btn = document.getElementById('btn-audio');
    audioActive = !audioActive;
    btn.innerText = audioActive ? "Audio: ON" : "Audio: OFF";
    logSystem(`Microphone input ${audioActive ? "enabled" : "disabled"}.`);
}

// Toggle Voice/TTS Output
function toggleVoice() {
    const btn = document.getElementById('btn-voice');
    voiceActive = !voiceActive;
    btn.innerText = voiceActive ? "Voice: ON" : "Voice: OFF";
    logSystem(`Text-to-speech voice output ${voiceActive ? "enabled" : "disabled"}.`);
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

    // Display in chat thread
    addChatMessage('User', text, 'user-msg');
    logSystem(`Executed command: ${text}`);

    input.value = '';

    // Simulated Backend Response Processing
    setTimeout(() => {
        const responseText = `Processed request: "${text}". Tasks executed successfully.`;
        addChatMessage('PG1 Agent', responseText, 'ai-msg');
        logSystem(`Agent response generated for instruction.`);

        if (voiceActive) {
            speakResponse(responseText);
        }
    }, 600);
}

// Speech Output directly speaking clean response text
function speakResponse(text) {
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel(); // Clear queued speech
        const utterance = new SpeechSynthesisUtterance(text);
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
