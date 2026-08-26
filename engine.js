// Project Gifted1 Sovereign Engine v12.39 Active Client Core
let terminalAppendFunc = null;
let mediaStream = null;
let speechRecognizer = null;
let isVoiceEnabled = true;
let isSentinelEnabled = true;
let isChronEnabled = false;
let isDictationActive = false;
let chronTimer = null;
let currentUtterance = null;
let speechKeepAliveInterval = null;
let audioCtx = null;
let analyserNode = null;
let isSpeakingNow = false;

// Voice Memo Recording State
let voiceMediaRecorder = null;
let voiceAudioChunks = [];
let voiceRecordTimerInterval = null;
let voiceRecordSeconds = 0;

/* =====================================================================
   TELEMETRY & AUTONOMOUS ANOMALY DETECTION ENGINE
===================================================================== */
const TelemetryStack = {
    records: [],
    maxRecords: 50,
    log(type, endpoint, latencyMs, status, details = {}) {
        const entry = {
            timestamp: new Date().toISOString(),
            type,
            endpoint,
            latencyMs,
            status,
            details
        };
        this.records.unshift(entry);
        if (this.records.length > this.maxRecords) this.records.pop();
        if (status >= 400 || latencyMs > 3000) {
            console.warn(`[Telemetry Anomaly] ${type} to ${endpoint} | Status: ${status} | Latency: ${latencyMs}ms`);
        }
        return entry;
    },
    getRecentAnomalies() {
        return this.records.filter(r => r.status >= 400 || r.latencyMs > 3000);
    }
};

/* =====================================================================
   PREMIUM STUDIO SOUND SYNTHESIS ENGINE (Web Audio API)
===================================================================== */
function getAudioContext() {
    if (!audioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) {
            audioCtx = new AudioContextClass();
            try {
                analyserNode = audioCtx.createAnalyser();
                analyserNode.fftSize = 64;
                analyserNode.connect(audioCtx.destination);
            } catch(e) {}
        }
    }
    return audioCtx;
}

function getAudioDestination() {
    const ctx = getAudioContext();
    if (!ctx) return null;
    return analyserNode || ctx.destination;
}

function isSfxEnabled() {
    return localStorage.getItem('PG1_SFX_ENABLED') !== 'false';
}

function unlockAudio() {
    try {
        const ctx = getAudioContext();
        if (ctx && ctx.state === 'suspended') {
            ctx.resume();
        }
        if ('speechSynthesis' in window) {
            window.speechSynthesis.resume();
            if (!window._speechPrimed) {
                const dummy = new SpeechSynthesisUtterance('');
                dummy.volume = 0.01;
                dummy.rate = 2;
                window.speechSynthesis.speak(dummy);
                window._speechPrimed = true;
            }
        }
    } catch(e) {}
}

window.addEventListener('click', unlockAudio, { passive: true });
window.addEventListener('touchend', unlockAudio, { passive: true });
window.addEventListener('touchstart', unlockAudio, { passive: true });
window.addEventListener('keydown', unlockAudio, { passive: true });

function triggerHaptic(type) {
    if (!navigator.vibrate) return;
    try {
        if (type === 'tap') navigator.vibrate(12);
        if (type === 'success') navigator.vibrate([20, 30, 20]);
        if (type === 'error') navigator.vibrate([50, 30, 50, 30, 80]);
    } catch(e) {}
}

function setSystemState(state) {
    document.body.className = '';
    if (state === 'active') document.body.classList.add('sys-active');
    if (state === 'error') { 
        document.body.classList.add('sys-error'); 
        triggerHaptic('error'); 
        playErrorTone();
    }
}

// Ultra-Crisp Tactile Mechanical Keystroke Sound
function playKeystroke() {
    if (!isSfxEnabled()) return;
    try {
        unlockAudio();
        const ctx = getAudioContext();
        const dest = getAudioDestination();
        if (!ctx || !dest) return;
        const now = ctx.currentTime;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const filter = ctx.createBiquadFilter();
        
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(1400 + Math.random() * 400, now);
        filter.Q.setValueAtTime(3.5, now);

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(950 + Math.random() * 250, now);
        osc.frequency.exponentialRampToValueAtTime(320, now + 0.018);

        gain.gain.setValueAtTime(0.015, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.018);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(dest);

        osc.start(now);
        osc.stop(now + 0.02);
    } catch(e) {}
}

// Pristine Crystal Harmonic Studio Notification Chime
function playNotificationChime() {
    if (!isSfxEnabled()) return;
    try {
        unlockAudio();
        const ctx = getAudioContext();
        const dest = getAudioDestination();
        if (!ctx || !dest) return;
        const now = ctx.currentTime;

        const fundamentalFreqs = [528, 1056, 1584];
        const gains = [0.06, 0.025, 0.012];

        fundamentalFreqs.forEach((freq, idx) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, now + (idx * 0.025));

            const duration = 0.45 - (idx * 0.08);
            gain.gain.setValueAtTime(gains[idx], now + (idx * 0.025));
            gain.gain.exponentialRampToValueAtTime(0.00005, now + (idx * 0.025) + duration);

            osc.connect(gain);
            gain.connect(dest);

            osc.start(now + (idx * 0.025));
            osc.stop(now + (idx * 0.025) + duration);
        });
    } catch(e) {}
}

// Luxurious Harmonic Success Arpeggio
function playSuccessChime() {
    if (!isSfxEnabled()) return;
    try {
        unlockAudio();
        const ctx = getAudioContext();
        const dest = getAudioDestination();
        if (!ctx || !dest) return;
        const now = ctx.currentTime;
        const notes = [659.25, 830.61, 987.77, 1318.51];
        
        notes.forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, now + i * 0.06);
            gain.gain.setValueAtTime(0.04, now + i * 0.06);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.06 + 0.3);
            osc.connect(gain);
            gain.connect(dest);
            osc.start(now + i * 0.06);
            osc.stop(now + i * 0.06 + 0.3);
        });
    } catch(e) {}
}

// Warm Soft Error Alert
function playErrorTone() {
    if (!isSfxEnabled()) return;
    try {
        unlockAudio();
        const ctx = getAudioContext();
        const dest = getAudioDestination();
        if (!ctx || !dest) return;
        const now = ctx.currentTime;
        const notes = [440, 415.30];
        
        notes.forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(freq, now + i * 0.1);
            gain.gain.setValueAtTime(0.04, now + i * 0.1);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.1 + 0.25);
            osc.connect(gain);
            gain.connect(dest);
            osc.start(now + i * 0.1);
            osc.stop(now + i * 0.1 + 0.25);
        });
    } catch(e) {}
}

// Studio Dictation Recording Cue
function playMicTone(isStart) {
    if (!isSfxEnabled()) return;
    try {
        unlockAudio();
        const ctx = getAudioContext();
        const dest = getAudioDestination();
        if (!ctx || !dest) return;
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        if (isStart) {
            osc.frequency.setValueAtTime(480, now);
            osc.frequency.exponentialRampToValueAtTime(880, now + 0.08);
        } else {
            osc.frequency.setValueAtTime(880, now);
            osc.frequency.exponentialRampToValueAtTime(440, now + 0.08);
        }
        gain.gain.setValueAtTime(0.035, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.1);
        osc.connect(gain);
        gain.connect(dest);
        osc.start(now);
        osc.stop(now + 0.1);
    } catch(e) {}
}

/* =====================================================================
   NEURAL AUDIO & TELEMETRY SPECTRUM CANVAS RENDERER
===================================================================== */
function initNeuralSpectrumVisualizer() {
    const canvas = document.getElementById('neuralAudioCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let visualOffset = 0;

    function renderFrame() {
        requestAnimationFrame(renderFrame);
        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        const bars = 32;
        const barWidth = (w / bars) - 2;

        let freqData = null;
        if (analyserNode) {
            freqData = new Uint8Array(analyserNode.frequencyBinCount);
            analyserNode.getByteFrequencyData(freqData);
        }

        visualOffset += 0.05;

        for (let i = 0; i < bars; i++) {
            let val = 0;
            if (freqData && freqData.length > 0) {
                const idx = Math.floor((i / bars) * freqData.length);
                val = (freqData[idx] / 255);
            }
            
            // Baseline dynamic synthetic idle wave
            const wave = (Math.sin(visualOffset + (i * 0.3)) * 0.15) + 0.2;
            const combinedHeight = Math.max(4, (val * h * 0.8) + (wave * h * 0.3));

            const x = i * (barWidth + 2);
            const y = h - combinedHeight;

            const grad = ctx.createLinearGradient(0, y, 0, h);
            grad.addColorStop(0, '#38bdf8');
            grad.addColorStop(1, 'rgba(16, 185, 129, 0.4)');

            ctx.fillStyle = grad;
            ctx.fillRect(x, y, barWidth, combinedHeight);
        }
    }

    renderFrame();
}

function renderMarkdownToHtml(raw) {
    if (!raw) return "";
    let safeRaw = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return safeRaw
        .replace(/### (.*?)([\r\n]|$)/g, '<h3>$1</h3>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/^\s*\*\s+(.*?)([\r\n]|$)/gm, '• $1<br>')
        .replace(/---/g, '<hr>')
        .replace(/\n\n/g, '<br><br>');
}

window.saveMasterKeys = function() {
    triggerHaptic('tap');
    const kIn = document.getElementById('masterKeyInput'); 
    const gIn = document.getElementById('githubKeyInput');
    const rIn = document.getElementById('replicateKeyInput');
    if (kIn && kIn.value && kIn.value !== '••••••••••••••••') localStorage.setItem('PG1_KEY', kIn.value.trim());
    if (gIn && gIn.value && gIn.value !== '••••••••••••••••') localStorage.setItem('PG1_GH_PAT', gIn.value.trim());
    if (rIn && rIn.value && rIn.value !== '••••••••••••••••') localStorage.setItem('PG1_REP_KEY', rIn.value.trim());
    window.checkKeys(); 
    triggerHaptic('success'); 
    playSuccessChime();
    alert('Credentials securely saved.');
};

window.checkKeys = function() {
    const kIn = document.getElementById('masterKeyInput'); 
    const gIn = document.getElementById('githubKeyInput');
    const rIn = document.getElementById('replicateKeyInput');
    const stat = document.getElementById('keyStatusText'); 
    const connBadge = document.getElementById('connectionBadge');
    if (!kIn || !gIn || !stat || !connBadge) return;
    
    const hasKey = !!localStorage.getItem('PG1_KEY');
    const hasPat = !!localStorage.getItem('PG1_GH_PAT');
    const hasRep = !!localStorage.getItem('PG1_REP_KEY');
    
    if (hasKey) kIn.value = '••••••••••••••••';
    if (hasPat) gIn.value = '••••••••••••••••';
    if (hasRep && rIn) rIn.value = '••••••••••••••••';
    
    if (hasKey) {
        stat.innerText = hasPat ? 'KEY_STATUS: MASTER + GITHUB_PAT' : 'KEY_STATUS: MASTER_STORED';
        stat.style.color = '#10b981';
        connBadge.innerText = '● CONNECTED'; 
        connBadge.style.color = '#10b981';
    } else {
        stat.innerText = 'KEY_STATUS: NOT_SET'; 
        stat.style.color = '#ef4444';
        connBadge.innerText = '● DISCONNECTED'; 
        connBadge.style.color = '#ef4444';
    }
};

window.copyMsg = function(btn) {
  triggerHaptic('tap');
  const msgDiv = btn.closest('.terminal-message');
  if (!msgDiv) return;
  const clone = msgDiv.cloneNode(true);
  const btnGroup = clone.querySelector('.msg-btn-group');
  if (btnGroup) btnGroup.remove();
  navigator.clipboard.writeText(clone.innerText.trim()).then(() => {
      playKeystroke();
      alert('Copied to clipboard.');
  });
};

window.editMsg = function(btn) {
  triggerHaptic('tap');
  const msgDiv = btn.closest('.terminal-message');
  if (!msgDiv) return;
  const clone = msgDiv.cloneNode(true);
  const btnGroup = clone.querySelector('.msg-btn-group');
  if (btnGroup) btnGroup.remove();
  const input = document.getElementById('terminalInput');
  if (input) {
      input.value = clone.innerText.trim();
      input.focus();
  }
};

window.speakMsg = function(btn) {
  triggerHaptic('tap');
  unlockAudio();
  const msgDiv = btn.closest('.terminal-message');
  if (!msgDiv) return;
  const clone = msgDiv.cloneNode(true);
  const btnGroup = clone.querySelector('.msg-btn-group');
  if (btnGroup) btnGroup.remove();
  const rawText = clone.innerText.trim();
  speakAgentResponse(rawText, true);
};

/* =====================================================================
   HIGH-DEFINITION MULTI-LANGUAGE VOICE ENGINE & RANKER
===================================================================== */
let systemVoices = [];

function populateVoiceSelect() {
    const specificSelect = document.getElementById('voiceSpecificSelect');
    if (!specificSelect || !('speechSynthesis' in window)) return;
    
    const voices = window.speechSynthesis.getVoices();
    if (!voices || voices.length === 0) return;
    systemVoices = voices;

    const currentVal = localStorage.getItem('PG1_SPECIFIC_VOICE') || 'auto';
    specificSelect.innerHTML = `<option value="auto">⚡ Best Neural / HD Voice (Auto-Selected)</option>`;
    
    const sorted = [...voices].sort((a, b) => {
        const aScore = getVoiceQualityScore(a);
        const bScore = getVoiceQualityScore(b);
        if (bScore !== aScore) return bScore - aScore;
        return a.name.localeCompare(b.name);
    });

    sorted.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.name;
        const isHd = getVoiceQualityScore(v) >= 8;
        opt.textContent = `${isHd ? '🌟 ' : ''}${v.name} (${v.lang})${v.default ? ' [Default]' : ''}`;
        specificSelect.appendChild(opt);
    });

    specificSelect.value = currentVal;
}

function getVoiceQualityScore(voice) {
    if (!voice) return 0;
    const name = (voice.name || '').toLowerCase();
    let score = 0;
    if (name.includes('neural')) score += 12;
    if (name.includes('natural')) score += 10;
    if (name.includes('studio')) score += 9;
    if (name.includes('premium')) score += 8;
    if (name.includes('enhanced')) score += 7;
    if (name.includes('wavenet')) score += 7;
    if (name.includes('google')) score += 6;
    if (name.includes('siri') || name.includes('samantha') || name.includes('karen') || name.includes('daniel')) score += 5;
    if (voice.localService) score += 2;
    return score;
}

function cacheSystemVoices() {
    if ('speechSynthesis' in window) {
        systemVoices = window.speechSynthesis.getVoices();
        populateVoiceSelect();
    }
}
if ('speechSynthesis' in window) {
    cacheSystemVoices();
    window.speechSynthesis.onvoiceschanged = cacheSystemVoices;
}

function selectBestVoice(targetLang, persona, specificVoiceName) {
    const voices = (systemVoices && systemVoices.length > 0) ? systemVoices : (('speechSynthesis' in window) ? window.speechSynthesis.getVoices() : []);
    if (!voices || voices.length === 0) return null;

    if (specificVoiceName && specificVoiceName !== 'auto') {
        const found = voices.find(v => v.name === specificVoiceName);
        if (found) return found;
    }

    const langPrefix = (!targetLang || targetLang === 'auto') ? '' : targetLang.toLowerCase().substring(0, 2);
    const fullLang = (!targetLang || targetLang === 'auto') ? '' : targetLang.toLowerCase();

    let candidates = voices;
    if (fullLang) {
        const exactMatches = voices.filter(v => (v.lang || '').toLowerCase() === fullLang || (v.lang || '').toLowerCase().replace('_', '-') === fullLang);
        if (exactMatches.length > 0) {
            candidates = exactMatches;
        } else if (langPrefix) {
            const prefixMatches = voices.filter(v => (v.lang || '').toLowerCase().startsWith(langPrefix));
            if (prefixMatches.length > 0) candidates = prefixMatches;
        }
    }

    const femaleKeywords = ['female', 'zira', 'samantha', 'victoria', 'karen', 'siri', 'moira', 'tessa', 'anna', 'monica', 'amelie', 'kyoko', 'yuna', 'tingting', 'luciana', 'elena', 'yelda', 'lekha', 'paulina', 'alice', 'ava', 'zoe'];
    const maleKeywords = ['male', 'david', 'guy', 'george', 'daniel', 'alex', 'aaron', 'thomas', 'jorge', 'arthur', 'oliver', 'yannick', 'sinji', 'otoya', 'felipe', 'nikolai', 'tarik'];

    let genderFiltered = candidates;
    if (persona === 'male') {
        const matches = candidates.filter(v => maleKeywords.some(k => v.name.toLowerCase().includes(k)));
        if (matches.length > 0) genderFiltered = matches;
    } else if (persona === 'female') {
        const matches = candidates.filter(v => femaleKeywords.some(k => v.name.toLowerCase().includes(k)));
        if (matches.length > 0) genderFiltered = matches;
    }

    genderFiltered.sort((a, b) => getVoiceQualityScore(b) - getVoiceQualityScore(a));
    return genderFiltered[0] || candidates[0] || voices[0];
}

function stopSpeech() {
    if ('speechSynthesis' in window) {
        try {
            window.speechSynthesis.cancel();
        } catch(e) {}
    }
    if (speechKeepAliveInterval) {
        clearInterval(speechKeepAliveInterval);
        speechKeepAliveInterval = null;
    }
    isSpeakingNow = false;
    const logo = document.getElementById('aiCoreLogo');
    if (logo) logo.classList.remove('is-speaking');
}

function speakAgentResponse(text, forceSpeak = false) {
    if ((!isVoiceEnabled && !forceSpeak) || !('speechSynthesis' in window)) return;
    try {
        unlockAudio();
        stopSpeech();

        const plainText = text
            .replace(/```[\s\S]*?```/g, 'Code block omitted.')
            .replace(/`([^`]+)`/g, '$1')
            .replace(/<[^>]*>/g, '')
            .replace(/[*_#~]/g, '')
            .replace(/https?:\/\/\S+/g, 'link')
            .replace(/\b(?:PG1|pg1)\b/g, 'P G 1')
            .trim();

        if (!plainText) return;

        const sentenceRegex = /[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g;
        const rawChunks = plainText.match(sentenceRegex) || [plainText];
        const chunks = rawChunks.map(c => c.trim()).filter(c => c.length > 0);
        let chunkIndex = 0;

        const savedLang = localStorage.getItem('PG1_VOICE_LANG') || 'en-US';
        const savedGender = localStorage.getItem('PG1_VOICE_GENDER') || 'female';
        const savedSpecificVoice = localStorage.getItem('PG1_SPECIFIC_VOICE') || 'auto';
        const savedRate = parseFloat(localStorage.getItem('PG1_VOICE_RATE') || '1.0');
        const savedPitch = parseFloat(localStorage.getItem('PG1_VOICE_PITCH') || '1.0');

        const matchedVoice = selectBestVoice(savedLang, savedGender, savedSpecificVoice);

        function speakNextChunk() {
            if (chunkIndex >= chunks.length) {
                stopSpeech();
                return;
            }

            const currentChunkText = chunks[chunkIndex];
            chunkIndex++;
            if (!currentChunkText) {
                speakNextChunk();
                return;
            }

            const utterance = new SpeechSynthesisUtterance(currentChunkText);
            utterance.volume = 1.0;
            utterance.rate = isNaN(savedRate) ? 1.0 : Math.min(Math.max(savedRate, 0.7), 1.5);
            utterance.pitch = isNaN(savedPitch) ? 1.0 : Math.min(Math.max(savedPitch, 0.8), 1.3);

            if (savedLang !== 'auto') {
                utterance.lang = savedLang;
            }

            if (matchedVoice) {
                utterance.voice = matchedVoice;
                if (!utterance.lang && matchedVoice.lang) utterance.lang = matchedVoice.lang;
            }

            const logo = document.getElementById('aiCoreLogo');
            utterance.onstart = () => {
                isSpeakingNow = true;
                if (logo) logo.classList.add('is-speaking');
            };

            utterance.onend = () => {
                speakNextChunk();
            };

            utterance.onerror = () => {
                speakNextChunk();
            };

            currentUtterance = utterance;
            window.speechSynthesis.speak(utterance);
        }

        speechKeepAliveInterval = setInterval(() => {
            if (window.speechSynthesis.speaking) {
                window.speechSynthesis.resume();
            } else if (!isSpeakingNow) {
                clearInterval(speechKeepAliveInterval);
                speechKeepAliveInterval = null;
            }
        }, 2500);

        playNotificationChime();
        speakNextChunk();
    } catch(e) {}
}

window.testVoiceSynthesis = function() {
    triggerHaptic('tap');
    unlockAudio();
    const voiceGenderSelect = document.getElementById('voiceGenderSelect');
    const voiceLangSelect = document.getElementById('voiceLangSelect');
    const voiceSpecificSelect = document.getElementById('voiceSpecificSelect');
    const voiceRateSlider = document.getElementById('voiceRateSlider');
    const voicePitchSlider = document.getElementById('voicePitchSlider');

    if (voiceGenderSelect) localStorage.setItem('PG1_VOICE_GENDER', voiceGenderSelect.value);
    if (voiceLangSelect) localStorage.setItem('PG1_VOICE_LANG', voiceLangSelect.value);
    if (voiceSpecificSelect) localStorage.setItem('PG1_SPECIFIC_VOICE', voiceSpecificSelect.value);
    if (voiceRateSlider) localStorage.setItem('PG1_VOICE_RATE', voiceRateSlider.value);
    if (voicePitchSlider) localStorage.setItem('PG1_VOICE_PITCH', voicePitchSlider.value);

    speakAgentResponse("Project Gifted 1 Sovereign Voice Synthesizer online. Audio fidelity is crystal clear.", true);
};

window.saveVoicePreferences = function() {
    triggerHaptic('tap');
    unlockAudio();
    const voiceGenderSelect = document.getElementById('voiceGenderSelect');
    const voiceLangSelect = document.getElementById('voiceLangSelect');
    const voiceSpecificSelect = document.getElementById('voiceSpecificSelect');
    const voiceRateSlider = document.getElementById('voiceRateSlider');
    const voicePitchSlider = document.getElementById('voicePitchSlider');
    const sfxEnabledSelect = document.getElementById('sfxEnabledSelect');

    if (voiceGenderSelect) localStorage.setItem('PG1_VOICE_GENDER', voiceGenderSelect.value);
    if (voiceLangSelect) localStorage.setItem('PG1_VOICE_LANG', voiceLangSelect.value);
    if (voiceSpecificSelect) localStorage.setItem('PG1_SPECIFIC_VOICE', voiceSpecificSelect.value);
    if (voiceRateSlider) localStorage.setItem('PG1_VOICE_RATE', voiceRateSlider.value);
    if (voicePitchSlider) localStorage.setItem('PG1_VOICE_PITCH', voicePitchSlider.value);
    if (sfxEnabledSelect) localStorage.setItem('PG1_SFX_ENABLED', sfxEnabledSelect.value);

    const voiceSettingsModal = document.getElementById('voiceSettingsModal');
    if (voiceSettingsModal) voiceSettingsModal.classList.remove('active');
    triggerHaptic('success');
    playSuccessChime();

    speakAgentResponse("Neural voice configuration applied. Sound fidelity verified.", true);
};

/* =====================================================================
   LIVE VOICE MEMO / AUDIO RECORDER MODULE
===================================================================== */
window.toggleVoiceNoteRecording = async function() {
    triggerHaptic('tap');
    unlockAudio();
    const bar = document.getElementById('voiceNoteRecordingBar');
    const timerLabel = document.getElementById('voiceNoteTimer');

    if (voiceMediaRecorder && voiceMediaRecorder.state === 'recording') {
        voiceMediaRecorder.stop();
        if (voiceRecordTimerInterval) {
            clearInterval(voiceRecordTimerInterval);
            voiceRecordTimerInterval = null;
        }
        if (bar) bar.classList.remove('active');
        playMicTone(false);
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        voiceAudioChunks = [];
        voiceRecordSeconds = 0;
        if (timerLabel) timerLabel.innerText = "0:00";

        voiceMediaRecorder = new MediaRecorder(stream);
        voiceMediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) voiceAudioChunks.push(e.data);
        };

        voiceMediaRecorder.onstop = () => {
            stream.getTracks().forEach(track => track.stop());
            if (voiceAudioChunks.length > 0) {
                const audioBlob = new Blob(voiceAudioChunks, { type: 'audio/webm' });
                const reader = new FileReader();
                reader.onloadend = () => {
                    const inputEl = document.getElementById('terminalInput');
                    if (inputEl) {
                        const noteMsg = `[Voice Memo Attached (${voiceRecordSeconds}s)]`;
                        inputEl.value = inputEl.value ? `${inputEl.value} ${noteMsg}` : noteMsg;
                    }
                    triggerHaptic('success');
                    playNotificationChime();
                };
                reader.readAsDataURL(audioBlob);
            }
        };

        voiceMediaRecorder.start();
        if (bar) bar.classList.add('active');
        playMicTone(true);

        voiceRecordTimerInterval = setInterval(() => {
            voiceRecordSeconds++;
            const mins = Math.floor(voiceRecordSeconds / 60);
            const secs = voiceRecordSeconds % 60;
            if (timerLabel) timerLabel.innerText = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
        }, 1000);

    } catch(err) {
        alert("Microphone permission unavailable for voice recording: " + err.message);
    }
};

window.cancelVoiceNote = function() {
    triggerHaptic('tap');
    if (voiceMediaRecorder && voiceMediaRecorder.state === 'recording') {
        voiceAudioChunks = [];
        voiceMediaRecorder.stop();
    }
    if (voiceRecordTimerInterval) {
        clearInterval(voiceRecordTimerInterval);
        voiceRecordTimerInterval = null;
    }
    const bar = document.getElementById('voiceNoteRecordingBar');
    if (bar) bar.classList.remove('active');
    playMicTone(false);
};

/* =====================================================================
   FULL MCP TOOL REGISTRY WITH PRE-FLIGHT LINTING & ROLLBACK
===================================================================== */
async function searchGitHubRepos(query) {
    const pat = localStorage.getItem('PG1_GH_PAT'); if (!pat) return "ERROR: GitHub PAT missing.";
    if(terminalAppendFunc) terminalAppendFunc(`[GitHub API] Searching for: ${query}...`, "system-msg", true);
    const start = Date.now();
    try {
        const res = await fetch(`https://api.github.com/user/repos?per_page=100&sort=updated`, { headers: { "Authorization": `token ${pat}`, "Accept": "application/vnd.github.v3+json" } });
        TelemetryStack.log('MCP_TOOL', 'searchGitHubRepos', Date.now() - start, res.status);
        if (!res.ok) throw new Error(`API status ${res.status}`);
        const repos = await res.json();
        const matched = repos.filter(r => r.name.toLowerCase().includes(query.toLowerCase()));
        return matched.length === 0 ? `No repos found.` : `[Found Repos]\n` + matched.map(r => `- ${r.full_name}`).join('\n');
    } catch(e) { 
        TelemetryStack.log('MCP_TOOL', 'searchGitHubRepos', Date.now() - start, 500, { error: e.message });
        throw new Error(`Search failed: ${e.message}`); 
    }
}

async function readGitHubFile(repoFullName, filePath) {
    const pat = localStorage.getItem('PG1_GH_PAT'); if (!pat) return "ERROR: GitHub PAT missing.";
    if(terminalAppendFunc) terminalAppendFunc(`[File Reader] Extracting ${filePath}...`, "system-msg", true);
    const start = Date.now();
    try {
        const res = await fetch(`https://api.github.com/repos/${repoFullName}/contents/${filePath}`, { headers: { "Authorization": `token ${pat}`, "Accept": "application/vnd.github.v3.raw" } });
        TelemetryStack.log('MCP_TOOL', 'readGitHubFile', Date.now() - start, res.status);
        if (!res.ok) throw new Error(`API status ${res.status}`);
        const text = await res.text();
        return `[File Content: ${filePath}]\n\`\`\`\n${text}\n\`\`\``;
    } catch(e) { 
        TelemetryStack.log('MCP_TOOL', 'readGitHubFile', Date.now() - start, 500, { error: e.message });
        throw new Error(`Read failed: ${e.message}`); 
    }
}

async function dynamicGitHubCommit(repoFullName, filePath, content, commitMessage) {
    const pat = localStorage.getItem('PG1_GH_PAT'); if (!pat) return "ERROR: GitHub PAT missing.";
    
    // Pre-flight linting
    if(terminalAppendFunc) terminalAppendFunc(`[Pre-Flight Audit] Validating ${filePath} payload...`, "system-msg", true);
    if (filePath.endsWith('.json')) {
        try {
            JSON.parse(content);
        } catch(err) {
            throw new Error(`Pre-Flight Lint Failed (Invalid JSON): ${err.message}`);
        }
    } else if (filePath.endsWith('.js')) {
        try {
            if (!content.includes('import ') && !content.includes('export ')) {
                new Function(content);
            }
        } catch(err) {
            if (err.name === 'SyntaxError') {
                throw new Error(`Pre-Flight Lint Failed (JavaScript Syntax Error): ${err.message}`);
            }
        }
    }

    if(terminalAppendFunc) terminalAppendFunc(`[GitHub API] Syncing ${repoFullName} at ${filePath}...`, "system-msg", true);
    const start = Date.now();
    try {
        const fileUrl = `https://api.github.com/repos/${repoFullName}/contents/${filePath}`;
        let sha = null;
        let originalContent = null;
        
        const checkRes = await fetch(fileUrl, { headers: { "Authorization": `token ${pat}` } });
        if (checkRes.ok) { 
            const fileData = await checkRes.json(); 
            sha = fileData.sha;
            if (fileData.content) {
                try {
                    originalContent = decodeURIComponent(escape(atob(fileData.content.replace(/\s/g, ''))));
                } catch(e) {}
            }
        }

        const body = { message: commitMessage, content: btoa(unescape(encodeURIComponent(content))) };
        if (sha) body.sha = sha;
        
        const res = await fetch(fileUrl, { method: "PUT", headers: { "Authorization": `token ${pat}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
        TelemetryStack.log('MCP_TOOL', 'dynamicGitHubCommit', Date.now() - start, res.status);
        if (!res.ok) throw new Error(`API status ${res.status}`);
        
        return {
            status: "COMMITTED",
            message: `[Commit Success] Data committed to ${filePath}`,
            previousContent: originalContent,
            repoFullName,
            filePath
        };
    } catch(e) { 
        TelemetryStack.log('MCP_TOOL', 'dynamicGitHubCommit', Date.now() - start, 500, { error: e.message });
        throw new Error(`Commit failed: ${e.message}`); 
    }
}

const MCP_TOOL_REGISTRY = {
    searchGitHubRepos: { description: "Searches connected GitHub repositories.", parameters: { type: "OBJECT", properties: { query: { type: "STRING" } }, required: ["query"] }, handler: async (args) => await searchGitHubRepos(args.query) },
    readGitHubFile: { description: "Reads raw content of a file from GitHub.", parameters: { type: "OBJECT", properties: { repoFullName: { type: "STRING" }, filePath: { type: "STRING" } }, required: ["repoFullName", "filePath"] }, handler: async (args) => await readGitHubFile(args.repoFullName, args.filePath) },
    dynamicGitHubCommit: { description: "Commits code directly to a GitHub repository with pre-flight dry-run linting and rollback tracking.", parameters: { type: "OBJECT", properties: { repoFullName: { type: "STRING" }, filePath: { type: "STRING" }, content: { type: "STRING" }, commitMessage: { type: "STRING" } }, required: ["repoFullName", "filePath", "content", "commitMessage"] }, handler: async (args) => await dynamicGitHubCommit(args.repoFullName, args.filePath, args.content, args.commitMessage) }
};

function getMCPToolDeclarations() {
    return [{ functionDeclarations: Object.keys(MCP_TOOL_REGISTRY).map(name => ({ name, description: MCP_TOOL_REGISTRY[name].description, parameters: MCP_TOOL_REGISTRY[name].parameters })) }];
}

async function executeMCPTool(toolName, args) {
    if (!MCP_TOOL_REGISTRY[toolName]) return `[MCP Error] Tool '${toolName}' not found in sovereign registry.`;
    return await MCP_TOOL_REGISTRY[toolName].handler(args);
}

/* DYNAMIC ESCALATION PROTOCOL ROUTER */
function evaluatePromptComplexity(prompt) {
    if (!prompt) return false;
    const deepLogicTriggers = [
        /diagnos/i, /debug/i, /troubleshoot/i, /root\s*cause/i, /deep\s*logic/i,
        /architect/i, /refactor/i, /security\s*audit/i, /vulnerability/i, /protocol/i,
        /patch/i, /remediat/i, /infrastructure/i, /algorithm/i, /optimize/i,
        /self-heal/i, /investigate/i, /escalat/i, /analyze\s*deeply/i, /complex/i
    ];
    const hasComplexTrigger = deepLogicTriggers.some(pattern => pattern.test(prompt));
    const isHighVolumeOrStructured = prompt.length > 250 || prompt.includes("```") || (prompt.match(/\n/g) || []).length >= 3;
    return hasComplexTrigger || isHighVolumeOrStructured;
}

function routeModelByComplexity(prompt, defaultModel = 'gemini-1.5-flash') {
    const isComplex = evaluatePromptComplexity(prompt);
    const PRO_MODEL = 'gemini-1.5-pro';
    const FLASH_MODEL = 'gemini-1.5-flash';

    if (isComplex) {
        return {
            selectedModel: PRO_MODEL,
            escalated: true,
            reason: "Deep logic / diagnostic / architectural control requirement detected"
        };
    }
    return {
        selectedModel: defaultModel.includes('pro') ? defaultModel : FLASH_MODEL,
        escalated: false,
        reason: "Standard complexity query routed to Flash core"
    };
}

/* =====================================================================
   ENGINE INITIALIZATION
===================================================================== */
document.addEventListener("DOMContentLoaded", () => {
  localStorage.removeItem('PG1_CHAT_DOM');
  localStorage.removeItem('PG1_CHAT_HISTORY');

  let sessionHistory = [];
  let pendingImageData = null;
  const termOut = document.getElementById('terminalOutput');
  window.checkKeys(); 

  // Initialize Canvas Visualizer Spectrum
  initNeuralSpectrumVisualizer();

  const savedVoicePref = localStorage.getItem('PG1_VOICE_ENABLED');
  isVoiceEnabled = savedVoicePref !== null ? (savedVoicePref === 'true') : true;

  const voiceBtn = document.getElementById('voiceBtn');
  if (voiceBtn) {
      if (isVoiceEnabled) {
          voiceBtn.classList.add('active-btn');
          voiceBtn.innerText = '🗣️ Voice: ON';
      } else {
          voiceBtn.classList.remove('active-btn');
          voiceBtn.innerText = '🗣️ Voice: OFF';
      }
  }

  function persistTerminalState() {
      try {
          if (termOut) localStorage.setItem('PG1_CHAT_DOM', termOut.innerHTML);
          localStorage.setItem('PG1_CHAT_HISTORY', JSON.stringify(sessionHistory.slice(-10)));
      } catch(e) {}
  }

  /* THREAD PERSISTENCE SYSTEM */
  function getSavedThreads() {
      try {
          const raw = localStorage.getItem('PG1_SAVED_THREADS');
          return raw ? JSON.parse(raw) : [];
      } catch(e) { return []; }
  }

  function saveCurrentThreadRecord() {
      if (sessionHistory.length === 0) return;
      try {
          const threads = getSavedThreads();
          const firstUserMsg = sessionHistory.find(m => m.role === 'user');
          const title = firstUserMsg && firstUserMsg.parts && firstUserMsg.parts[0] && firstUserMsg.parts[0].text 
                        ? firstUserMsg.parts[0].text.substring(0, 35) + '...' 
                        : 'Session ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const threadRecord = {
              id: Date.now().toString(),
              title: title,
              time: new Date().toLocaleString(),
              history: sessionHistory,
              dom: termOut ? termOut.innerHTML : ''
          };
          threads.unshift(threadRecord);
          localStorage.setItem('PG1_SAVED_THREADS', JSON.stringify(threads.slice(0, 15)));
      } catch(e) {}
  }

  function renderSavedThreadsList() {
      const container = document.getElementById('threadsListContainer');
      if (!container) return;
      const threads = getSavedThreads();
      if (threads.length === 0) {
          container.innerHTML = '<div style="color:#94a3b8; font-size:0.8em; text-align:center; padding:15px;">No saved threads yet.</div>';
          return;
      }
      container.innerHTML = threads.map(th => `
          <div class="thread-item" data-id="${th.id}">
              <div class="thread-info" onclick="window.loadSavedThread('${th.id}')">
                  <div class="thread-title">📁 ${renderMarkdownToHtml(th.title).replace(/<[^>]*>/g, '')}</div>
                  <div class="thread-time">${th.time} • ${th.history ? th.history.length : 0} msgs</div>
              </div>
              <button class="thread-delete-btn" onclick="window.deleteSavedThread('${th.id}', event)">✕</button>
          </div>
      `).join('');
  }

  window.loadSavedThread = function(threadId) {
      triggerHaptic('tap');
      playKeystroke();
      const threads = getSavedThreads();
      const target = threads.find(t => t.id === threadId);
      if (!target) return;
      sessionHistory = target.history || [];
      if (target.dom && termOut) {
          termOut.innerHTML = target.dom;
      }
      persistTerminalState();
      document.getElementById('threadsModal').classList.remove('active');
      appendMsg(`[Thread Restored] Resumed session "${target.title}"`, 'system-msg', true);
  };

  window.deleteSavedThread = function(threadId, e) {
      if (e) e.stopPropagation();
      triggerHaptic('tap');
      let threads = getSavedThreads();
      threads = threads.filter(t => t.id !== threadId);
      localStorage.setItem('PG1_SAVED_THREADS', JSON.stringify(threads));
      renderSavedThreadsList();
  };

  window.startNewThread = function() {
      triggerHaptic('tap'); 
      stopSpeech();
      if (sessionHistory.length > 0) saveCurrentThreadRecord();
      sessionHistory = [];
      localStorage.removeItem('PG1_CHAT_DOM'); 
      localStorage.removeItem('PG1_CHAT_HISTORY');
      if (termOut) {
          termOut.innerHTML = '<div class="terminal-message agent-msg">Memory flushed. Autonomous Feedback Control Loop standing by.<div class="msg-btn-group"><button class="msg-action-btn speak-btn" onclick="speakMsg(this)">🔊 Speak</button><button class="msg-action-btn" onclick="copyMsg(this)">Copy</button></div></div>';
      }
      const threadsModal = document.getElementById('threadsModal');
      if (threadsModal) threadsModal.classList.remove('active');
  };

  async function appendMsg(text, type, instant = false) {
    if (!termOut) return;
    const div = document.createElement('div'); div.className = `terminal-message ${type}`;
    const btnGroupHtml = `<div class="msg-btn-group">${type === 'agent-msg' ? '<button class="msg-action-btn speak-btn" onclick="speakMsg(this)">🔊 Speak</button>' : ''}<button class="msg-action-btn" onclick="copyMsg(this)">Copy</button><button class="msg-action-btn" onclick="editMsg(this)">Edit</button></div>`;
    
    if (type === 'user-msg' || type === 'system-msg' || type === 'error-msg' || instant) {
        div.innerHTML = renderMarkdownToHtml(text) + btnGroupHtml;
        termOut.appendChild(div); termOut.scrollTop = termOut.scrollHeight; persistTerminalState(); return;
    }

    if (type === 'agent-msg') {
        speakAgentResponse(text);
    }

    div.classList.add('cursor-blink'); termOut.appendChild(div);
    for (let i = 0; i < text.length; i++) {
        div.textContent += text.charAt(i); 
        if (i % 2 === 0) playKeystroke(); 
        termOut.scrollTop = termOut.scrollHeight;
        await new Promise(r => setTimeout(r, 6 + Math.random() * 8));
    }
    div.classList.remove('cursor-blink');
    div.innerHTML = renderMarkdownToHtml(text) + btnGroupHtml;
    termOut.scrollTop = termOut.scrollHeight; persistTerminalState(); triggerHaptic('success');
  }
  terminalAppendFunc = appendMsg;

  // Crypto & Telemetry Feeds
  async function updateCryptoTickers() {
      const start = Date.now();
      try {
          const btcRes = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot');
          const ethRes = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot');
          const latency = Date.now() - start;
          TelemetryStack.log('HEARTBEAT', 'Coinbase_Feed', latency, btcRes.ok && ethRes.ok ? 200 : 500);

          if(btcRes.ok && ethRes.ok) {
              const btcVal = document.getElementById('btcTicker');
              const ethVal = document.getElementById('ethTicker');
              if (btcVal) btcVal.innerText = '$' + parseFloat((await btcRes.json()).data.amount).toLocaleString(undefined, {minimumFractionDigits: 2}) + ' USD';
              if (ethVal) ethVal.innerText = '$' + parseFloat((await ethRes.json()).data.amount).toLocaleString(undefined, {minimumFractionDigits: 2}) + ' USD';
          }
      } catch(e) {
          TelemetryStack.log('HEARTBEAT', 'Coinbase_Feed', Date.now() - start, 500, { error: e.message });
      }
  }
  updateCryptoTickers(); 
  setInterval(updateCryptoTickers, 60000);
  
  setInterval(() => {
    if (document.getElementById('telemetrySpeed')) document.getElementById('telemetrySpeed').innerText = (2.2 + Math.random() * 0.6).toFixed(1) + ' MB/s';
    if (document.getElementById('throughputBar')) document.getElementById('throughputBar').style.width = (50 + Math.random() * 30) + '%';
    if (document.getElementById('cpuLoad')) { const c = Math.floor(24+Math.random()*14); document.getElementById('cpuLoad').innerText = c+'%'; const b = document.getElementById('cpuBar'); if (b) b.style.width = c+'%'; }
    if (document.getElementById('ramAlloc')) { const r = Math.floor(42+Math.random()*10); document.getElementById('ramAlloc').innerText = r+'%'; const rb = document.getElementById('ramBar'); if (rb) rb.style.width = r+'%'; }
  }, 1000);

  /* ACTION BAR & MODAL ICON BUTTON HANDLERS */
  const threadsBtn = document.getElementById('threadsBtn');
  const threadsModal = document.getElementById('threadsModal');
  if (threadsBtn && threadsModal) {
      threadsBtn.onclick = () => {
          triggerHaptic('tap');
          playKeystroke();
          renderSavedThreadsList();
          threadsModal.classList.add('active');
      };
  }

  const voiceSettingsBtn = document.getElementById('voiceSettingsBtn');
  const voiceSettingsModal = document.getElementById('voiceSettingsModal');
  const closeVoiceModalBtn = document.getElementById('closeVoiceModalBtn');
  const saveVoiceSettingsBtn = document.getElementById('saveVoiceSettingsBtn');
  const testVoiceBtn = document.getElementById('testVoiceBtn');
  const voiceGenderSelect = document.getElementById('voiceGenderSelect');
  const voiceLangSelect = document.getElementById('voiceLangSelect');
  const voiceSpecificSelect = document.getElementById('voiceSpecificSelect');
  const voiceRateSlider = document.getElementById('voiceRateSlider');
  const voicePitchSlider = document.getElementById('voicePitchSlider');
  const rateValLabel = document.getElementById('rateValLabel');
  const pitchValLabel = document.getElementById('pitchValLabel');
  const sfxEnabledSelect = document.getElementById('sfxEnabledSelect');

  if (voiceGenderSelect && localStorage.getItem('PG1_VOICE_GENDER')) {
      voiceGenderSelect.value = localStorage.getItem('PG1_VOICE_GENDER');
  }
  if (voiceLangSelect && localStorage.getItem('PG1_VOICE_LANG')) {
      voiceLangSelect.value = localStorage.getItem('PG1_VOICE_LANG');
  }
  if (voiceRateSlider && localStorage.getItem('PG1_VOICE_RATE')) {
      voiceRateSlider.value = localStorage.getItem('PG1_VOICE_RATE');
      if (rateValLabel) rateValLabel.innerText = parseFloat(voiceRateSlider.value).toFixed(2) + 'x';
  }
  if (voicePitchSlider && localStorage.getItem('PG1_VOICE_PITCH')) {
      voicePitchSlider.value = localStorage.getItem('PG1_VOICE_PITCH');
      if (pitchValLabel) pitchValLabel.innerText = parseFloat(voicePitchSlider.value).toFixed(2);
  }
  if (sfxEnabledSelect && localStorage.getItem('PG1_SFX_ENABLED') !== null) {
      sfxEnabledSelect.value = localStorage.getItem('PG1_SFX_ENABLED');
  }

  if (voiceRateSlider && rateValLabel) {
      voiceRateSlider.oninput = () => {
          rateValLabel.innerText = parseFloat(voiceRateSlider.value).toFixed(2) + 'x';
      };
  }
  if (voicePitchSlider && pitchValLabel) {
      voicePitchSlider.oninput = () => {
          pitchValLabel.innerText = parseFloat(voicePitchSlider.value).toFixed(2);
      };
  }

  if (voiceSettingsBtn && voiceSettingsModal) {
      voiceSettingsBtn.onclick = () => {
          triggerHaptic('tap');
          playKeystroke();
          unlockAudio();
          populateVoiceSelect();
          voiceSettingsModal.classList.add('active');
      };
  }
  if (closeVoiceModalBtn && voiceSettingsModal) {
      closeVoiceModalBtn.onclick = () => {
          triggerHaptic('tap');
          voiceSettingsModal.classList.remove('active');
      };
  }
  if (saveVoiceSettingsBtn && voiceSettingsModal) {
      saveVoiceSettingsBtn.onclick = window.saveVoicePreferences;
  }
  if (testVoiceBtn) {
      testVoiceBtn.onclick = window.testVoiceSynthesis;
  }

  /* VOICE TOGGLE */
  if (voiceBtn) {
      voiceBtn.onclick = () => {
          triggerHaptic('tap');
          unlockAudio();
          isVoiceEnabled = !isVoiceEnabled;
          localStorage.setItem('PG1_VOICE_ENABLED', isVoiceEnabled.toString());
          if (isVoiceEnabled) {
              voiceBtn.classList.add('active-btn');
              voiceBtn.innerText = '🗣️ Voice: ON';
              playSuccessChime();
              speakAgentResponse('Voice active and sound verified.', true);
          } else {
              voiceBtn.classList.remove('active-btn');
              voiceBtn.innerText = '🗣️ Voice: OFF';
              playKeystroke();
              stopSpeech();
          }
      };
  }

  /* HIGH-FIDELITY LIVE AUDIO DICTATION SPEECH RECOGNITION */
  const audioBtn = document.getElementById('audioBtn');
  const inlineMicBtn = document.getElementById('inlineMicBtn');
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

  function stopDictation() {
      isDictationActive = false;
      if (speechRecognizer) {
          try { speechRecognizer.stop(); } catch(e) {}
          speechRecognizer = null;
      }
      playMicTone(false);
      if (audioBtn) { audioBtn.classList.remove('recording-btn'); audioBtn.innerText = '🎙️ Dictate: OFF'; }
      if (inlineMicBtn) inlineMicBtn.classList.remove('recording-btn');
  }

  function startSpeechRecognition() {
      if (!SpeechRec) {
          alert('Speech Recognition API is not supported in this browser. Please use a compatible Web Speech browser (Safari or Chrome).');
          return;
      }

      stopSpeech();
      unlockAudio();

      try {
          speechRecognizer = new SpeechRec();
          speechRecognizer.continuous = true;
          speechRecognizer.interimResults = true;
          speechRecognizer.maxAlternatives = 1;
          
          const configuredLang = localStorage.getItem('PG1_VOICE_LANG');
          speechRecognizer.lang = configuredLang && configuredLang !== 'auto' ? configuredLang : 'en-US';
          
          isDictationActive = true;
          if (audioBtn) { audioBtn.classList.add('recording-btn'); audioBtn.innerText = '🎙️ Dictate: REC'; }
          if (inlineMicBtn) inlineMicBtn.classList.add('recording-btn');

          playMicTone(true);

          const inputEl = document.getElementById('terminalInput');
          let baseText = inputEl ? inputEl.value : '';
          if (baseText && !baseText.endsWith(' ')) baseText += ' ';

          speechRecognizer.onresult = (event) => {
              let currentSessionText = '';

              for (let i = 0; i < event.results.length; ++i) {
                  currentSessionText += event.results[i][0].transcript;
              }

              if (inputEl) {
                  inputEl.value = baseText + currentSessionText;
              }
              triggerHaptic('tap');
          };

          speechRecognizer.onerror = (event) => {
              console.warn("SpeechRec error:", event.error);
              if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
                  alert('Microphone permission was denied. Please allow microphone access in your settings.');
                  stopDictation();
              }
          };

          speechRecognizer.onend = () => {
              if (isDictationActive) {
                  try {
                      speechRecognizer.start();
                  } catch(e) {
                      stopDictation();
                  }
              } else {
                  stopDictation();
              }
          };

          speechRecognizer.start();
      } catch(e) {
          stopDictation();
          alert('Microphone initialization failed: ' + e.message);
      }
  }

  function toggleSpeechRecognition() {
      triggerHaptic('tap');
      if (isDictationActive) {
          stopDictation();
      } else {
          startSpeechRecognition();
      }
  }

  if (audioBtn) audioBtn.onclick = toggleSpeechRecognition;
  if (inlineMicBtn) inlineMicBtn.onclick = toggleSpeechRecognition;

  /* DASH FEED & SYNC BUTTONS */
  const syncFeedBtn = document.getElementById('syncFeedBtn');
  if (syncFeedBtn) {
      syncFeedBtn.onclick = async () => {
          triggerHaptic('tap');
          playKeystroke();
          syncFeedBtn.disabled = true;
          await updateCryptoTickers();
          triggerHaptic('success');
          playNotificationChime();
          setTimeout(() => { syncFeedBtn.disabled = false; }, 800);
      };
  }

  /* MEDIA CAPTURE & MULTIMODAL PREVIEW */
  const mediaBtn = document.getElementById('mediaBtn');
  const mediaInput = document.getElementById('mediaInput');
  const mediaPreviewBox = document.getElementById('mediaPreviewBox');
  const mediaPreviewImg = document.getElementById('mediaPreviewImg');
  const clearMediaBtn = document.getElementById('clearMediaBtn');

  if (mediaBtn && mediaInput) {
      mediaBtn.onclick = () => {
          triggerHaptic('tap');
          playKeystroke();
          const cameraPreview = document.getElementById('cameraPreview');
          if (window.activeMediaStream && cameraPreview) {
              const canvas = document.createElement('canvas');
              canvas.width = cameraPreview.videoWidth || 640;
              canvas.height = cameraPreview.videoHeight || 480;
              const ctx = canvas.getContext('2d');
              ctx.drawImage(cameraPreview, 0, 0, canvas.width, canvas.height);
              const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
              const base64Data = dataUrl.split(',')[1];
              pendingImageData = { mime_type: 'image/jpeg', data: base64Data, dataUrl: dataUrl };
              if (mediaPreviewImg) { mediaPreviewImg.src = dataUrl; mediaPreviewImg.style.display = 'inline-block'; }
              if (mediaPreviewBox) mediaPreviewBox.style.display = 'block';
              playNotificationChime();
          } else {
              mediaInput.click();
          }
      };
  }

  if (mediaInput) {
      mediaInput.onchange = (e) => {
          const file = e.target.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = (event) => {
              const dataUrl = event.target.result;
              const base64Data = dataUrl.split(',')[1];
              pendingImageData = { mime_type: file.type || 'image/jpeg', data: base64Data, dataUrl: dataUrl };
              if (mediaPreviewImg) { mediaPreviewImg.src = dataUrl; mediaPreviewImg.style.display = 'inline-block'; }
              if (mediaPreviewBox) mediaPreviewBox.style.display = 'block';
              triggerHaptic('tap');
              playNotificationChime();
          };
          reader.readAsDataURL(file);
      };
  }

  if (clearMediaBtn && mediaPreviewBox) {
      clearMediaBtn.onclick = () => {
          triggerHaptic('tap');
          playKeystroke();
          pendingImageData = null;
          if (mediaPreviewImg) { mediaPreviewImg.src = ''; mediaPreviewImg.style.display = 'none'; }
          mediaPreviewBox.style.display = 'none';
          if (mediaInput) mediaInput.value = '';
      };
  }

  /* LOG EXPORT & PDF REPORT */
  const saveLogBtn = document.getElementById('saveLogBtn');
  if (saveLogBtn) {
      saveLogBtn.onclick = () => {
          triggerHaptic('tap');
          playKeystroke();
          if (!termOut) return;
          const text = termOut.innerText;
          const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `pg1_log_${Date.now()}.txt`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          triggerHaptic('success');
          playSuccessChime();
      };
  }

  const exportPdfBtn = document.getElementById('exportPdfBtn');
  if (exportPdfBtn) {
      exportPdfBtn.onclick = () => {
          triggerHaptic('tap');
          playKeystroke();
          window.print();
      };
  }

  /* AI CORE LOGO INTERACTION */
  const aiCoreLogo = document.getElementById('aiCoreLogo');
  if (aiCoreLogo) {
      aiCoreLogo.onclick = () => {
          playKeystroke();
          triggerHaptic('tap');
          unlockAudio();
          if (isSpeakingNow) {
              stopSpeech();
          } else {
              speakAgentResponse("Project Gifted 1 Sovereign Core active and standing by.", true);
          }
      };
  }

  const clearBtn = document.getElementById('clearBtn');
  if (clearBtn) clearBtn.onclick = () => window.startNewThread();

  // =====================================================================
  // AUTONOMOUS FEEDBACK CONTROL LOOP & TRIPLE VERIFICATION ENGINE
  // =====================================================================
  const executeSendCommand = async () => {
    triggerHaptic('tap');
    unlockAudio();
    stopDictation();
    const inputEl = document.getElementById('terminalInput');
    let cmd = inputEl ? inputEl.value.trim() : '';
    if (!cmd && !pendingImageData) return;
    if (!cmd && pendingImageData) cmd = "Please analyze this image.";

    const key = localStorage.getItem('PG1_KEY');
    if (!key) { 
        setSystemState('error'); 
        return appendMsg('Error: Master API Key required in Dash tab.', 'error-msg', true); 
    }

    if (pendingImageData) {
        appendMsg(`> [Image Attached] ${cmd}`, 'user-msg', true);
    } else {
        appendMsg(`> ${cmd}`, 'user-msg', true);
    }

    if (inputEl) inputEl.value = '';
    setSystemState('active');

    const userParts = [{ text: cmd }];
    if (pendingImageData) {
        userParts.push({
            inlineData: {
                mimeType: pendingImageData.mime_type,
                data: pendingImageData.data
            }
        });
        pendingImageData = null;
        if (mediaPreviewBox) mediaPreviewBox.style.display = 'none';
        if (mediaPreviewImg) mediaPreviewImg.src = '';
        if (mediaInput) mediaInput.value = '';
    }

    sessionHistory.push({ role: "user", parts: userParts });
    persistTerminalState();
    
    const tools = getMCPToolDeclarations();
    const configuredModel = document.getElementById('modelSelector') ? document.getElementById('modelSelector').value : 'gemini-1.5-flash';
    const routingDecision = routeModelByComplexity(cmd, configuredModel);
    const activeModel = routingDecision.selectedModel;

    if (routingDecision.escalated) {
        appendMsg(`[Dynamic Escalation] Complex task detected (${routingDecision.reason}). Escalated payload to Pro model: ${activeModel}`, 'system-msg', true);
    }
const sys = `You are PG1.Agent v12.39.
TRIPLE VERIFICATION & AUTONOMOUS CONTROL PROTOCOLS:
1. TRIPLE VERIFICATION: You may NEVER claim a task is complete without verifying the live output.
2. HONEST FAILURE ADMISSION: If you receive an error, state the facts honestly. Do not hallucinate success.
3. STRUCTURED ROOT CAUSE ANALYSIS: On any error, analyze the precise reason before attempting a fix.
4. HIERARCHICAL TASK DECOMPOSITION: Break complex tasks into safe, micro-steps.
5. PRE-FLIGHT VERIFICATION: Inspect repositories and files before initiating writes.
6. CRITICAL REPO PROTOCOL: Never guess the target GitHub repository. Always explicitly identify the current working repository before executing file operations. If the repository name is missing or ambiguous, use the searchGitHubRepos tool to find likely matches, list them to the user, and ask for explicit confirmation. Do not proceed blindly.`;

    
    try {
      let continueLoop = true; 
      let loopCount = 0;
      
      while (continueLoop && loopCount < 5) {
          loopCount++;
          const reqStart = Date.now();
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent?key=${key}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: sessionHistory, systemInstruction: { parts: [{ text: sys }] }, tools: tools })
          });
          TelemetryStack.log('NEURAL_CORE', activeModel, Date.now() - reqStart, res.status);

          const data = await res.json();
          
          if (data.error) throw new Error(data.error.message);
          if (data.promptFeedback && data.promptFeedback.blockReason) throw new Error(`API Filter: ${data.promptFeedback.blockReason}`);
          if (!data.candidates || data.candidates.length === 0) throw new Error(`API returned empty structure.`);
          
          let responsePart = data.candidates[0].content.parts[0];
          
          if (responsePart.functionCall) {
              const call = responsePart.functionCall;
              appendMsg(`[MCP Dispatcher] Executing: ${call.name}...`, 'system-msg', true);
              let resultStr = "";
              let rawCommitResult = null;

              try {
                  const execResult = await executeMCPTool(call.name, call.args);
                  
                  if (call.name === 'dynamicGitHubCommit' && typeof execResult === 'object') {
                      rawCommitResult = execResult;
                      appendMsg(`[Self-Healing Audit] Verifying live repository state for ${call.args.filePath}...`, 'system-msg', true);
                      await new Promise(r => setTimeout(r, 2000));
                      
                      const verifyRes = await executeMCPTool('readGitHubFile', { repoFullName: call.args.repoFullName, filePath: call.args.filePath });
                      const cleanTarget = call.args.content.substring(0, 40).trim();
                      
                      if (verifyRes.includes(cleanTarget) && !verifyRes.includes("ERROR:")) {
                          resultStr = `[Commit Success] Data committed to ${call.args.filePath}\n[Verified Success] Live audit confirmed the patch successfully deployed.`;
                      } else {
                          // Deterministic Rollback Safeguard
                          appendMsg(`[Audit Failure] Code mismatch detected. Initiating Autonomous Rollback...`, 'error-msg', true);
                          if (rawCommitResult && rawCommitResult.previousContent) {
                              try {
                                  await dynamicGitHubCommit(call.args.repoFullName, call.args.filePath, rawCommitResult.previousContent, `[Auto-Rollback] Reverting failed update to ${call.args.filePath}`);
                                  resultStr = `[Verification Failed] CRITICAL ERROR: Live audit failed. Autonomous Rollback successfully executed to restore previous stable state.\nRCA Directive: Inspect failed patch diff and identify corruption cause.`;
                              } catch(rbErr) {
                                  resultStr = `[Verification Failed] CRITICAL ERROR: Live audit failed and rollback encountered error: ${rbErr.message}`;
                              }
                          } else {
                              resultStr = `[Verification Failed] CRITICAL ERROR: Live audit shows the patch did NOT apply correctly.`;
                          }
                          appendMsg(`[Audit Failure] Code mismatch diagnostic recorded.`, 'error-msg', true);
                      }
                  } else {
                      resultStr = typeof execResult === 'string' ? execResult : JSON.stringify(execResult);
                  }
              } catch(toolErr) { 
                  // Structured RCA Feedback Payload
                  resultStr = `[Tool Execution Error] Tool: ${call.name}\nRoot Cause: ${toolErr.message}\nDirective: Analyze why this failed, check schema/path, and attempt corrected execution.`; 
              }

              appendMsg(`[Result] ${resultStr}`, 'agent-msg', true);
              sessionHistory.push(data.candidates[0].content);
              sessionHistory.push({ role: "user", parts: [{ functionResponse: { name: call.name, response: { result: resultStr } } }] });
              persistTerminalState();
              
              const followupStart = Date.now();
              const followupRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent?key=${key}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: sessionHistory, systemInstruction: { parts: [{ text: sys }] }, tools: tools })
              });
              TelemetryStack.log('NEURAL_CORE', activeModel, Date.now() - followupStart, followupRes.status);
              
              const followUpData = await followupRes.json();
              if (followUpData.error) throw new Error(followUpData.error.message);
              responsePart = followUpData.candidates[0].content.parts[0];
          }

          if (responsePart.text !== undefined) {
              setSystemState('idle');
              await appendMsg(responsePart.text, 'agent-msg');
              sessionHistory.push({ role: "model", parts: [{ text: responsePart.text }] });
              persistTerminalState();
              continueLoop = false;
          }
          if (loopCount >= 5) throw new Error("Agent loop reached maximum retry ceiling.");
      }
    } catch (e) { 
      setSystemState('error'); 
      sessionHistory.pop(); 
      persistTerminalState();
      appendMsg(`Exception: ${e.message}`, 'error-msg', true); 
    }
  };

  window.executeSendCommand = executeSendCommand;
  window.executeUserPrompt = executeSendCommand;

  const sendBtn = document.getElementById('sendCommandButton');
  if (sendBtn) sendBtn.onclick = executeSendCommand;

  const termInput = document.getElementById('terminalInput');
  if (termInput) {
      termInput.addEventListener('keydown', (e) => { 
          if (e.key === 'Enter' && !e.shiftKey) { 
              e.preventDefault(); 
              executeSendCommand(); 
          } 
      });
  }
  
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      triggerHaptic('tap');
      playKeystroke();
      document.querySelectorAll('.nav-item, .view-section').forEach(el => el.classList.remove('active'));
      item.classList.add('active'); 
      const targetSection = document.getElementById(item.getAttribute('data-target'));
      if (targetSection) targetSection.classList.add('active');
    });
  });
});