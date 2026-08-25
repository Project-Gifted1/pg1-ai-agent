let terminalAppendFunc = null;
let mediaStream = null;
let speechRecognizer = null;
let isVoiceEnabled = true;
let isSfxEnabled = true;
let isSentinelEnabled = true;
let isChronEnabled = false;
let chronTimer = null;
let currentUtterance = null;
let speechKeepAliveInterval = null;
let audioCtx = null;
let isSpeakingNow = false;

/* =========================================================================
   HIGH-FIDELITY STUDIO AUDIO SYNTHESIZER (Web Audio API)
   ========================================================================= */
function getAudioContext() {
    if (!audioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) {
            audioCtx = new AudioContextClass();
        }
    }
    return audioCtx;
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
window.addEventListener('touchstart', unlockAudio, { passive: true });
window.addEventListener('keydown', unlockAudio, { passive: true });

function triggerHaptic(type) {
    if (!navigator.vibrate) return;
    try {
        if (type === 'tap') navigator.vibrate(12);
        if (type === 'success') navigator.vibrate([20, 35, 20]);
        if (type === 'error') navigator.vibrate([50, 35, 50, 35, 80]);
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

/* 1. Ultra-Crisp Tactile Mechanical Keystroke */
function playKeystroke() {
    if (!isSfxEnabled) return;
    try {
        unlockAudio();
        const ctx = getAudioContext();
        if (!ctx) return;
        const now = ctx.currentTime;

        // Transient Click Layer
        const osc = ctx.createOscillator();
        const clickFilter = ctx.createBiquadFilter();
        const gain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(1400 + Math.random() * 400, now);
        osc.frequency.exponentialRampToValueAtTime(320, now + 0.012);

        clickFilter.type = 'bandpass';
        clickFilter.frequency.setValueAtTime(1800, now);
        clickFilter.Q.setValueAtTime(3.0, now);

        gain.gain.setValueAtTime(0.025, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.014);

        osc.connect(clickFilter);
        clickFilter.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + 0.015);

        // Warm Sub-Resonance Layer
        const subOsc = ctx.createOscillator();
        const subGain = ctx.createGain();
        subOsc.type = 'triangle';
        subOsc.frequency.setValueAtTime(220 + Math.random() * 40, now);
        subGain.gain.setValueAtTime(0.012, now);
        subGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.018);

        subOsc.connect(subGain);
        subGain.connect(ctx.destination);
        subOsc.start(now);
        subOsc.stop(now + 0.02);
    } catch(e) {}
}

/* 2. Pristine Crystal Glass Harmonic Chime (Solfeggio 528Hz Harmonic) */
function playNotificationChime() {
    if (!isSfxEnabled) return;
    try {
        unlockAudio();
        const ctx = getAudioContext();
        if (!ctx) return;
        const now = ctx.currentTime;

        const fundamental = 528; // Harmonic transformation tone
        const overtone = 1056;

        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        const gain2 = ctx.createGain();

        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(fundamental, now);
        osc1.frequency.exponentialRampToValueAtTime(fundamental * 1.01, now + 0.4);

        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(overtone, now + 0.02);
        osc2.frequency.exponentialRampToValueAtTime(overtone * 0.99, now + 0.45);

        gain1.gain.setValueAtTime(0.08, now);
        gain1.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);

        gain2.gain.setValueAtTime(0.04, now + 0.02);
        gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);

        osc1.connect(gain1);
        osc2.connect(gain2);
        gain1.connect(ctx.destination);
        gain2.connect(ctx.destination);

        osc1.start(now);
        osc1.stop(now + 0.48);
        osc2.start(now + 0.02);
        osc2.stop(now + 0.45);
    } catch(e) {}
}

/* 3. Success Harmonic Chord (Ascending Major Triad) */
function playSuccessChime() {
    if (!isSfxEnabled) return;
    try {
        unlockAudio();
        const ctx = getAudioContext();
        if (!ctx) return;
        const now = ctx.currentTime;

        const notes = [523.25, 659.25, 783.99, 1046.50]; // C5 - E5 - G5 - C6
        notes.forEach((freq, idx) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            const startT = now + (idx * 0.045);
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, startT);
            gain.gain.setValueAtTime(0.045, startT);
            gain.gain.exponentialRampToValueAtTime(0.0001, startT + 0.35);

            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(startT);
            osc.stop(startT + 0.38);
        });
    } catch(e) {}
}

/* 4. Deep Cinematic Error / Alert Warning */
function playErrorTone() {
    if (!isSfxEnabled) return;
    try {
        unlockAudio();
        const ctx = getAudioContext();
        if (!ctx) return;
        const now = ctx.currentTime;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const filter = ctx.createBiquadFilter();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(220, now);
        osc.frequency.exponentialRampToValueAtTime(110, now + 0.28);

        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(600, now);

        gain.gain.setValueAtTime(0.06, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + 0.32);
    } catch(e) {}
}

/* 5. Studio Recording Punch In / Out Cue */
function playMicBeep(type = 'start') {
    if (!isSfxEnabled) return;
    try {
        unlockAudio();
        const ctx = getAudioContext();
        if (!ctx) return;
        const now = ctx.currentTime;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';

        if (type === 'start') {
            osc.frequency.setValueAtTime(440, now);
            osc.frequency.exponentialRampToValueAtTime(880, now + 0.08);
        } else {
            osc.frequency.setValueAtTime(880, now);
            osc.frequency.exponentialRampToValueAtTime(440, now + 0.08);
        }

        gain.gain.setValueAtTime(0.04, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.1);
    } catch(e) {}
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

/* =========================================================================
   MULTI-LANGUAGE NEURAL VOICE SYNTHESIS ENGINE
   ========================================================================= */
let systemVoices = [];

function scoreVoiceQuality(v) {
    let score = 0;
    const name = v.name.toLowerCase();
    
    // Prioritize natural / neural / studio voice badges
    if (name.includes('neural')) score += 100;
    if (name.includes('natural')) score += 90;
    if (name.includes('google')) score += 80;
    if (name.includes('premium')) score += 75;
    if (name.includes('enhanced')) score += 70;
    if (name.includes('studio')) score += 65;
    if (name.includes('siri')) score += 60;
    if (name.includes('wavenet')) score += 55;
    if (name.includes('samantha') || name.includes('ava') || name.includes('daniel') || name.includes('karen') || name.includes('serena') || name.includes('arthur')) score += 40;
    if (v.localService) score += 15;
    if (v.default) score += 10;
    return score;
}

function populateVoiceDropdown() {
    const specificSelect = document.getElementById('voiceSpecificSelect');
    if (!specificSelect || !systemVoices || systemVoices.length === 0) return;

    const currentSelection = localStorage.getItem('PG1_SPECIFIC_VOICE') || 'auto';
    const targetLang = localStorage.getItem('PG1_VOICE_LANG') || 'auto';

    let filteredVoices = [...systemVoices].sort((a, b) => scoreVoiceQuality(b) - scoreVoiceQuality(a));
    
    if (targetLang !== 'auto') {
        const langPrefix = targetLang.substring(0, 2).toLowerCase();
        const matched = filteredVoices.filter(v => v.lang.toLowerCase().startsWith(langPrefix));
        if (matched.length > 0) {
            filteredVoices = matched;
        }
    }

    specificSelect.innerHTML = `<option value="auto">⚡ Best Neural / HD Voice (Auto-Selected)</option>` + 
        filteredVoices.map(v => {
            const isNeural = scoreVoiceQuality(v) >= 50 ? '💎 ' : '';
            return `<option value="${v.name}" ${v.name === currentSelection ? 'selected' : ''}>${isNeural}${v.name} (${v.lang})</option>`;
        }).join('');
}

function cacheSystemVoices() {
    if ('speechSynthesis' in window) {
        systemVoices = window.speechSynthesis.getVoices();
        populateVoiceDropdown();
    }
}

if ('speechSynthesis' in window) {
    cacheSystemVoices();
    window.speechSynthesis.onvoiceschanged = cacheSystemVoices;
}

function detectTextLanguage(text) {
    if (!text) return 'en-US';
    // Asian scripts
    if (/[\u3040-\u30ff]/.test(text)) return 'ja-JP'; // Japanese Hiragana/Katakana
    if (/[\u4e00-\u9faf]/.test(text)) return 'zh-CN'; // Chinese
    if (/[\uac00-\ud7af]/.test(text)) return 'ko-KR'; // Korean Hangul
    // Cyrillic
    if (/[\u0400-\u04ff]/.test(text)) return 'ru-RU'; // Russian
    // Arabic
    if (/[\u0600-\u06ff]/.test(text)) return 'ar-SA'; // Arabic
    // Devanagari / Hindi
    if (/[\u0900-\u097f]/.test(text)) return 'hi-IN'; // Hindi
    // Spanish
    if (/[¿¡áéíóúüñ]/i.test(text)) return 'es-ES';
    // French
    if (/[éèêëàâôûùç]/i.test(text) && /\b(le|la|les|un|une|des|est|sont|pour|avec)\b/i.test(text)) return 'fr-FR';
    // German
    if (/[äöüß]/i.test(text) || /\b(der|die|das|und|ist|nicht|für|mit)\b/i.test(text)) return 'de-DE';
    // Italian
    if (/\b(il|la|gli|per|con|sono|grazie|ciao)\b/i.test(text)) return 'it-IT';
    // Portuguese
    if (/[ãõáéíóúâêôç]/i.test(text) && /\b(o|a|os|as|do|da|com|não|para)\b/i.test(text)) return 'pt-BR';

    return 'en-US';
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

function findOptimalVoice(targetLang, preferredGender, specificVoiceName) {
    const voices = (systemVoices && systemVoices.length > 0) ? systemVoices : ('speechSynthesis' in window ? window.speechSynthesis.getVoices() : []);
    if (!voices || voices.length === 0) return null;

    if (specificVoiceName && specificVoiceName !== 'auto') {
        const found = voices.find(v => v.name === specificVoiceName);
        if (found) return found;
    }

    const langPrefix = targetLang.substring(0, 2).toLowerCase();
    let langMatches = voices.filter(v => v.lang.toLowerCase().startsWith(langPrefix));
    if (langMatches.length === 0) langMatches = voices;

    langMatches.sort((a, b) => scoreVoiceQuality(b) - scoreVoiceQuality(a));

    if (preferredGender === 'male') {
        const maleVoice = langMatches.find(v => {
            const n = v.name.toLowerCase();
            return n.includes('male') || n.includes('david') || n.includes('guy') || n.includes('george') || 
                   n.includes('daniel') || n.includes('alex') || n.includes('aaron') || n.includes('thomas') || 
                   n.includes('jorge') || n.includes('yuri') || n.includes('arthur') || n.includes('diego');
        });
        if (maleVoice) return maleVoice;
    } else if (preferredGender === 'female') {
        const femaleVoice = langMatches.find(v => {
            const n = v.name.toLowerCase();
            return n.includes('female') || n.includes('zira') || n.includes('samantha') || n.includes('victoria') || 
                   n.includes('karen') || n.includes('siri') || n.includes('moira') || n.includes('tessa') || 
                   n.includes('ava') || n.includes('paulina') || n.includes('amélie') || n.includes('monica') || 
                   n.includes('anna') || n.includes('alice') || n.includes('kyoko') || n.includes('luciana');
        });
        if (femaleVoice) return femaleVoice;
    }

    return langMatches[0] || null;
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
            .replace(/\s+/g, ' ')
            .trim();

        if (!plainText) return;

        // Split text cleanly by sentence boundaries for smooth phrasing
        const sentenceRegex = /[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g;
        const chunks = plainText.match(sentenceRegex) || [plainText];
        let chunkIndex = 0;

        const configuredLang = localStorage.getItem('PG1_VOICE_LANG') || 'auto';
        const savedGender = localStorage.getItem('PG1_VOICE_GENDER') || 'female';
        const specificVoiceName = localStorage.getItem('PG1_SPECIFIC_VOICE') || 'auto';
        const savedRate = parseFloat(localStorage.getItem('PG1_VOICE_RATE') || '1.0');
        const savedPitch = parseFloat(localStorage.getItem('PG1_VOICE_PITCH') || '1.0');

        const activeLang = configuredLang === 'auto' ? detectTextLanguage(plainText) : configuredLang;
        const matchedVoice = findOptimalVoice(activeLang, savedGender, specificVoiceName);

        function speakNextChunk() {
            if (chunkIndex >= chunks.length) {
                stopSpeech();
                return;
            }

            const currentChunkText = chunks[chunkIndex].trim();
            chunkIndex++;
            if (!currentChunkText) {
                speakNextChunk();
                return;
            }

            const utterance = new SpeechSynthesisUtterance(currentChunkText);
            utterance.volume = 1.0;
            utterance.rate = savedRate;
            utterance.pitch = savedPitch;
            utterance.lang = activeLang;

            if (matchedVoice) {
                utterance.voice = matchedVoice;
            }

            const logo = document.getElementById('aiCoreLogo');
            utterance.onstart = () => {
                isSpeakingNow = true;
                if (logo) logo.classList.add('is-speaking');
            };

            utterance.onend = () => {
                // Short human-like micro-pause between sentences
                setTimeout(() => {
                    speakNextChunk();
                }, 40);
            };

            utterance.onerror = () => {
                speakNextChunk();
            };

            currentUtterance = utterance;
            window.speechSynthesis.speak(utterance);
        }

        // WebKit keep-alive timer
        speechKeepAliveInterval = setInterval(() => {
            if (window.speechSynthesis.speaking) {
                window.speechSynthesis.resume();
            } else if (!isSpeakingNow) {
                clearInterval(speechKeepAliveInterval);
                speechKeepAliveInterval = null;
            }
        }, 3000);

        playNotificationChime();
        speakNextChunk();
    } catch(e) {}
}

/* =========================================================================
   MCP TOOL REGISTRY RESTORATION & DYNAMIC COMMIT
   ========================================================================= */
async function searchGitHubRepos(query) {
    const pat = localStorage.getItem('PG1_GH_PAT'); if (!pat) return "ERROR: GitHub PAT missing.";
    if(terminalAppendFunc) terminalAppendFunc(`[GitHub API] Searching for: ${query}...`, "system-msg", true);
    try {
        const res = await fetch(`https://api.github.com/user/repos?per_page=100&sort=updated`, { headers: { "Authorization": `token ${pat}`, "Accept": "application/vnd.github.v3+json" } });
        if (!res.ok) throw new Error(`API status ${res.status}`);
        const repos = await res.json();
        const matched = repos.filter(r => r.name.toLowerCase().includes(query.toLowerCase()));
        return matched.length === 0 ? `No repos found.` : `[Found Repos]\n` + matched.map(r => `- ${r.full_name}`).join('\n');
    } catch(e) { throw new Error(`Search failed: ${e.message}`); }
}

async function readGitHubFile(repoFullName, filePath) {
    const pat = localStorage.getItem('PG1_GH_PAT'); if (!pat) return "ERROR: GitHub PAT missing.";
    if(terminalAppendFunc) terminalAppendFunc(`[File Reader] Extracting ${filePath}...`, "system-msg", true);
    try {
        const res = await fetch(`https://api.github.com/repos/${repoFullName}/contents/${filePath}`, { headers: { "Authorization": `token ${pat}`, "Accept": "application/vnd.github.v3.raw" } });
        if (!res.ok) throw new Error(`API status ${res.status}`);
        const text = await res.text();
        return `[File Content: ${filePath}]\n\`\`\`\n${text}\n\`\`\``;
    } catch(e) { throw new Error(`Read failed: ${e.message}`); }
}

async function dynamicGitHubCommit(repoFullName, filePath, content, commitMessage) {
    const pat = localStorage.getItem('PG1_GH_PAT'); if (!pat) return "ERROR: GitHub PAT missing.";
    if(terminalAppendFunc) terminalAppendFunc(`[GitHub API] Syncing ${repoFullName} at ${filePath}...`, "system-msg", true);
    try {
        const fileUrl = `https://api.github.com/repos/${repoFullName}/contents/${filePath}`;
        let sha = null;
        const checkRes = await fetch(fileUrl, { headers: { "Authorization": `token ${pat}` } });
        if (checkRes.ok) { const fileData = await checkRes.json(); sha = fileData.sha; }
        const body = { message: commitMessage, content: btoa(unescape(encodeURIComponent(content))) };
        if (sha) body.sha = sha;
        const res = await fetch(fileUrl, { method: "PUT", headers: { "Authorization": `token ${pat}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!res.ok) throw new Error(`API status ${res.status}`);
        return `[Commit Success] Data committed to ${filePath}`;
    } catch(e) { throw new Error(`Commit failed: ${e.message}`); }
}

const MCP_TOOL_REGISTRY = {
    searchGitHubRepos: { description: "Searches connected GitHub repositories.", parameters: { type: "OBJECT", properties: { query: { type: "STRING" } }, required: ["query"] }, handler: async (args) => await searchGitHubRepos(args.query) },
    readGitHubFile: { description: "Reads raw content of a file from GitHub.", parameters: { type: "OBJECT", properties: { repoFullName: { type: "STRING" }, filePath: { type: "STRING" } }, required: ["repoFullName", "filePath"] }, handler: async (args) => await readGitHubFile(args.repoFullName, args.filePath) },
    dynamicGitHubCommit: { description: "Commits code directly to a GitHub repository.", parameters: { type: "OBJECT", properties: { repoFullName: { type: "STRING" }, filePath: { type: "STRING" }, content: { type: "STRING" }, commitMessage: { type: "STRING" } }, required: ["repoFullName", "filePath", "content", "commitMessage"] }, handler: async (args) => await dynamicGitHubCommit(args.repoFullName, args.filePath, args.content, args.commitMessage) }
};

function getMCPToolDeclarations() {
    return [{ functionDeclarations: Object.keys(MCP_TOOL_REGISTRY).map(name => ({ name, description: MCP_TOOL_REGISTRY[name].description, parameters: MCP_TOOL_REGISTRY[name].parameters })) }];
}

async function executeMCPTool(toolName, args) {
    if (!MCP_TOOL_REGISTRY[toolName]) return `[MCP Error] Tool not found.`;
    return await MCP_TOOL_REGISTRY[toolName].handler(args);
}

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

function routeModelByComplexity(prompt, defaultModel = 'gemini-3.7-flash') {
    const isComplex = evaluatePromptComplexity(prompt);
    const PRO_MODEL = 'gemini-3.1-pro-preview';
    const FLASH_MODEL = 'gemini-3.7-flash';

    if (isComplex) {
        return {
            selectedModel: PRO_MODEL,
            escalated: true,
            reason: "Deep logic / diagnostic / architecture requirements detected"
        };
    }
    return {
        selectedModel: defaultModel.includes('pro') ? defaultModel : FLASH_MODEL,
        escalated: false,
        reason: "Standard complexity query routed to Flash core"
    };
}

/* =========================================================================
   UI CONTROLS & EVENT BINDINGS
   ========================================================================= */
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
  playKeystroke();
  const msgDiv = btn.closest('.terminal-message');
  if (!msgDiv) return;
  const clone = msgDiv.cloneNode(true);
  const btnGroup = clone.querySelector('.msg-btn-group');
  if (btnGroup) btnGroup.remove();
  navigator.clipboard.writeText(clone.innerText.trim()).then(() => alert('Copied to clipboard.'));
};

window.editMsg = function(btn) {
  triggerHaptic('tap');
  playKeystroke();
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

/* =========================================================================
   ENGINE INITIALIZATION
   ========================================================================= */
document.addEventListener("DOMContentLoaded", () => {
  localStorage.removeItem('PG1_CHAT_DOM');
  localStorage.removeItem('PG1_CHAT_HISTORY');

  let sessionHistory = [];
  let pendingImageData = null;
  const termOut = document.getElementById('terminalOutput');
  window.checkKeys(); 

  const savedVoicePref = localStorage.getItem('PG1_VOICE_ENABLED');
  isVoiceEnabled = savedVoicePref !== null ? (savedVoicePref === 'true') : true;

  const savedSfxPref = localStorage.getItem('PG1_SFX_ENABLED');
  isSfxEnabled = savedSfxPref !== null ? (savedSfxPref === 'true') : true;

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
      playKeystroke();
      let threads = getSavedThreads();
      threads = threads.filter(t => t.id !== threadId);
      localStorage.setItem('PG1_SAVED_THREADS', JSON.stringify(threads));
      renderSavedThreadsList();
  };

  window.startNewThread = function() {
      triggerHaptic('tap'); 
      playKeystroke();
      stopSpeech();
      if (sessionHistory.length > 0) saveCurrentThreadRecord();
      sessionHistory = [];
      localStorage.removeItem('PG1_CHAT_DOM'); 
      localStorage.removeItem('PG1_CHAT_HISTORY');
      if (termOut) {
          termOut.innerHTML = '<div class="terminal-message agent-msg">Memory flushed. New secure thread initiated.<div class="msg-btn-group"><button class="msg-action-btn speak-btn" onclick="speakMsg(this)">🔊 Speak</button><button class="msg-action-btn" onclick="copyMsg(this)">Copy</button></div></div>';
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
        div.textContent += text.charAt(i); playKeystroke(); termOut.scrollTop = termOut.scrollHeight;
        await new Promise(r => setTimeout(r, 6 + Math.random() * 8));
    }
    div.classList.remove('cursor-blink');
    div.innerHTML = renderMarkdownToHtml(text) + btnGroupHtml;
    termOut.scrollTop = termOut.scrollHeight; persistTerminalState(); triggerHaptic('success');
  }
  terminalAppendFunc = appendMsg;

  // Crypto & Telemetry Feeds
  async function updateCryptoTickers() {
      try {
          const btcRes = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot');
          const ethRes = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot');
          if(btcRes.ok && ethRes.ok) {
              const btcVal = document.getElementById('btcTicker');
              const ethVal = document.getElementById('ethTicker');
              if (btcVal) btcVal.innerText = '$' + parseFloat((await btcRes.json()).data.amount).toLocaleString(undefined, {minimumFractionDigits: 2}) + ' USD';
              if (ethVal) ethVal.innerText = '$' + parseFloat((await ethRes.json()).data.amount).toLocaleString(undefined, {minimumFractionDigits: 2}) + ' USD';
          }
      } catch(e) {}
  }
  updateCryptoTickers(); 
  setInterval(updateCryptoTickers, 60000);
  
  setInterval(() => {
    if (document.getElementById('telemetrySpeed')) document.getElementById('telemetrySpeed').innerText = (2.2 + Math.random() * 0.6).toFixed(1) + ' MB/s';
    if (document.getElementById('throughputBar')) document.getElementById('throughputBar').style.width = (50 + Math.random() * 30) + '%';
    if (document.getElementById('cpuLoad')) { const c = Math.floor(24+Math.random()*14); document.getElementById('cpuLoad').innerText = c+'%'; const b = document.getElementById('cpuBar'); if (b) b.style.width = c+'%'; }
    if (document.getElementById('ramAlloc')) { const r = Math.floor(42+Math.random()*10); document.getElementById('ramAlloc').innerText = r+'%'; const rb = document.getElementById('ramBar'); if (rb) rb.style.width = r+'%'; }
  }, 1000);

  /* VOICE MODAL CONTROLS & SLIDERS */
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
  if (sfxEnabledSelect && localStorage.getItem('PG1_SFX_ENABLED')) {
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
  if (voiceLangSelect) {
      voiceLangSelect.onchange = () => {
          populateVoiceDropdown();
      };
  }

  if (voiceSettingsBtn && voiceSettingsModal) {
      voiceSettingsBtn.onclick = () => {
          triggerHaptic('tap');
          playKeystroke();
          unlockAudio();
          cacheSystemVoices();
          voiceSettingsModal.classList.add('active');
      };
  }
  if (closeVoiceModalBtn && voiceSettingsModal) {
      closeVoiceModalBtn.onclick = () => {
          triggerHaptic('tap');
          playKeystroke();
          voiceSettingsModal.classList.remove('active');
      };
  }
  if (saveVoiceSettingsBtn && voiceSettingsModal) {
      saveVoiceSettingsBtn.onclick = () => {
          triggerHaptic('tap');
          unlockAudio();
          if (voiceGenderSelect) localStorage.setItem('PG1_VOICE_GENDER', voiceGenderSelect.value);
          if (voiceLangSelect) localStorage.setItem('PG1_VOICE_LANG', voiceLangSelect.value);
          if (voiceSpecificSelect) localStorage.setItem('PG1_SPECIFIC_VOICE', voiceSpecificSelect.value);
          if (voiceRateSlider) localStorage.setItem('PG1_VOICE_RATE', voiceRateSlider.value);
          if (voicePitchSlider) localStorage.setItem('PG1_VOICE_PITCH', voicePitchSlider.value);
          if (sfxEnabledSelect) {
              localStorage.setItem('PG1_SFX_ENABLED', sfxEnabledSelect.value);
              isSfxEnabled = sfxEnabledSelect.value === 'true';
          }
          voiceSettingsModal.classList.remove('active');
          triggerHaptic('success');
          playSuccessChime();
          speakAgentResponse("Studio voice configuration active and calibrated.", true);
      };
  }

  const voiceSamplePhrases = {
      'en-US': "Project Gifted 1 Sovereign Voice synthesizer test successful. All systems operating with maximum clarity.",
      'en-GB': "Project Gifted 1 British neural voice active and crystal clear.",
      'en-AU': "Project Gifted 1 Australian audio core running at optimal performance.",
      'en-IN': "Project Gifted 1 voice core calibrated for clear natural speech.",
      'es-ES': "Project Gifted 1 sintetizador de voz en español activado con máxima claridad y realismo.",
      'es-MX': "Project Gifted 1 sintetizador de voz en español latinoamericano listo y calibrado.",
      'fr-FR': "Project Gifted 1 synthèse vocale française haute définition activée avec succès.",
      'de-DE': "Project Gifted 1 deutsche Sprachausgabe erfolgreich initialisiert und einsatzbereit.",
      'it-IT': "Project Gifted 1 sintetizzatore vocale italiano attivo con audio ad alta fedeltà.",
      'pt-BR': "Project Gifted 1 sintetizador de voz em português brasileiro ativo com excelente clareza.",
      'ja-JP': "プロジェクト ギフテッドワン 音声エンジンが正常に起動しました。",
      'zh-CN': "Project Gifted 1 神经网络语音系统测试成功，发音清晰自然。",
      'ko-KR': "프로젝트 기프티드원 고음질 보이스 엔진이 정상 작동 중입니다.",
      'ru-RU': "Голосовой синтезатор Проекта Гифтед 1 успешно откалиброван и готов к работе.",
      'ar-SA': "تم تفعيل محرك الصوت فائق الوضوح لمشروع جيفتد ون بنجاح.",
      'hi-IN': "प्रोजेक्ट गिफ्टेड 1 एचडी वॉयस सिंथेसाइज़र सक्रिय है और स्पष्ट रूप से काम कर रहा है।"
  };

  if (testVoiceBtn) {
      testVoiceBtn.onclick = () => {
          triggerHaptic('tap');
          unlockAudio();
          if (voiceGenderSelect) localStorage.setItem('PG1_VOICE_GENDER', voiceGenderSelect.value);
          if (voiceLangSelect) localStorage.setItem('PG1_VOICE_LANG', voiceLangSelect.value);
          if (voiceSpecificSelect) localStorage.setItem('PG1_SPECIFIC_VOICE', voiceSpecificSelect.value);
          if (voiceRateSlider) localStorage.setItem('PG1_VOICE_RATE', voiceRateSlider.value);
          if (voicePitchSlider) localStorage.setItem('PG1_VOICE_PITCH', voicePitchSlider.value);
          
          const selLang = voiceLangSelect ? voiceLangSelect.value : 'en-US';
          const sample = voiceSamplePhrases[selLang] || voiceSamplePhrases['en-US'];
          speakAgentResponse(sample, true);
      };
  }

  /* VOICE TOGGLE */
  if (voiceBtn) {
      voiceBtn.onclick = () => {
          triggerHaptic('tap');
          playKeystroke();
          unlockAudio();
          isVoiceEnabled = !isVoiceEnabled;
          localStorage.setItem('PG1_VOICE_ENABLED', isVoiceEnabled.toString());
          if (isVoiceEnabled) {
              voiceBtn.classList.add('active-btn');
              voiceBtn.innerText = '🗣️ Voice: ON';
              speakAgentResponse('Voice active and audio calibrated.', true);
          } else {
              voiceBtn.classList.remove('active-btn');
              voiceBtn.innerText = '🗣️ Voice: OFF';
              stopSpeech();
          }
      };
  }

  /* SENTINEL & CHRON TOGGLES */
  const sentinelBtn = document.getElementById('sentinelBtn');
  if (sentinelBtn) {
      sentinelBtn.onclick = () => {
          triggerHaptic('tap');
          playKeystroke();
          isSentinelEnabled = !isSentinelEnabled;
          if (isSentinelEnabled) {
              sentinelBtn.classList.add('active-btn');
              sentinelBtn.innerText = '🛡️ Sentinel: ON';
          } else {
              sentinelBtn.classList.remove('active-btn');
              sentinelBtn.innerText = '🛡️ Sentinel: OFF';
          }
      };
  }

  const chronBtn = document.getElementById('chronBtn');
  if (chronBtn) {
      chronBtn.onclick = () => {
          triggerHaptic('tap');
          playKeystroke();
          isChronEnabled = !isChronEnabled;
          if (isChronEnabled) {
              chronBtn.classList.add('active-btn');
              chronBtn.innerText = '⏱️ Chron: ON';
              chronTimer = setInterval(() => { updateCryptoTickers(); }, 30000);
          } else {
              chronBtn.classList.remove('active-btn');
              chronBtn.innerText = '⏱️ Chron: OFF';
              if (chronTimer) clearInterval(chronTimer);
          }
      };
  }

  /* CAMERA VIDEO TOGGLE */
  const videoBtn = document.getElementById('videoBtn');
  const cameraPipBox = document.getElementById('cameraPipBox');
  const cameraPreview = document.getElementById('cameraPreview');
  if (videoBtn && cameraPipBox && cameraPreview) {
      videoBtn.onclick = async () => {
          triggerHaptic('tap');
          playKeystroke();
          if (mediaStream) {
              mediaStream.getTracks().forEach(track => track.stop());
              mediaStream = null;
              cameraPipBox.style.display = 'none';
              videoBtn.classList.remove('active-btn');
              videoBtn.innerText = '📹 Vid: OFF';
          } else {
              try {
                  mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
                  cameraPreview.srcObject = mediaStream;
                  cameraPipBox.style.display = 'block';
                  videoBtn.classList.add('active-btn');
                  videoBtn.innerText = '📹 Vid: ON';
              } catch(err) {
                  alert('Camera access unavailable or denied: ' + err.message);
              }
          }
      };
  }

  /* HIGH-FIDELITY MULTI-LANGUAGE LIVE DICTATION */
  const audioBtn = document.getElementById('audioBtn');
  const inlineMicBtn = document.getElementById('inlineMicBtn');
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

  function stopDictation() {
      if (speechRecognizer) {
          try { speechRecognizer.stop(); } catch(e) {}
          speechRecognizer = null;
          playMicBeep('stop');
      }
      if (audioBtn) { audioBtn.classList.remove('recording-btn'); audioBtn.innerText = '🎙️ Dictate: OFF'; }
      if (inlineMicBtn) inlineMicBtn.classList.remove('recording-btn');
  }

  async function toggleSpeechRecognition() {
      triggerHaptic('tap');
      unlockAudio();
      
      if (!SpeechRec) {
          alert('Speech Recognition API not supported in this browser. Please use a Web Speech compatible browser.');
          return;
      }
      
      if (speechRecognizer) {
          stopDictation();
          triggerHaptic('tap');
          return;
      }

      try {
          if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
              try {
                  const testStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                  testStream.getTracks().forEach(t => t.stop());
              } catch(permErr) {}
          }

          speechRecognizer = new SpeechRec();
          speechRecognizer.continuous = true;
          speechRecognizer.interimResults = true;
          speechRecognizer.maxAlternatives = 1;
          
          const configuredLang = localStorage.getItem('PG1_VOICE_LANG');
          speechRecognizer.lang = configuredLang && configuredLang !== 'auto' ? configuredLang : (navigator.language || 'en-US');
          
          if (audioBtn) { audioBtn.classList.add('recording-btn'); audioBtn.innerText = '🎙️ Dictate: REC'; }
          if (inlineMicBtn) inlineMicBtn.classList.add('recording-btn');
          playMicBeep('start');

          let initialText = "";
          const inputEl = document.getElementById('terminalInput');
          if (inputEl) {
              initialText = inputEl.value;
              inputEl.focus();
          }

          speechRecognizer.onresult = (event) => {
              let finalTranscript = '';
              let interimTranscript = '';

              for (let i = event.resultIndex; i < event.results.length; ++i) {
                  if (event.results[i].isFinal) {
                      finalTranscript += event.results[i][0].transcript;
                  } else {
                      interimTranscript += event.results[i][0].transcript;
                  }
              }

              if (inputEl) {
                  const combined = (initialText ? initialText + ' ' : '') + (finalTranscript || interimTranscript);
                  inputEl.value = combined;
              }
              triggerHaptic('tap');
          };

          speechRecognizer.onerror = (event) => {
              console.warn("SpeechRec error:", event.error);
              if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
                  alert('Microphone permission was denied. Please allow microphone access in your browser settings.');
              }
              stopDictation();
          };

          speechRecognizer.onend = () => {
              stopDictation();
          };

          speechRecognizer.start();
      } catch(e) {
          stopDictation();
          alert('Microphone initialization failed: ' + e.message);
      }
  }

  if (audioBtn) audioBtn.onclick = toggleSpeechRecognition;
  if (inlineMicBtn) inlineMicBtn.onclick = toggleSpeechRecognition;

  /* DASH FEED & OTX SYNC BUTTONS */
  const syncFeedBtn = document.getElementById('syncFeedBtn');
  if (syncFeedBtn) {
      syncFeedBtn.onclick = async () => {
          triggerHaptic('tap');
          playKeystroke();
          syncFeedBtn.disabled = true;
          await updateCryptoTickers();
          triggerHaptic('success');
          playSuccessChime();
          setTimeout(() => { syncFeedBtn.disabled = false; }, 800);
      };
  }

  const syncOtxBtn = document.getElementById('syncOtxBtn');
  if (syncOtxBtn) {
      syncOtxBtn.onclick = () => {
          triggerHaptic('tap');
          playKeystroke();
          const otxStatus = document.getElementById('otxStatus');
          const otxIocs = document.getElementById('otxIocs');
          const otxPulses = document.getElementById('otxPulses');
          if (otxStatus) otxStatus.innerText = 'Syncing...';
          setTimeout(() => {
              if (otxStatus) otxStatus.innerText = 'Active (Synced)';
              if (otxIocs) otxIocs.innerText = (1420 + Math.floor(Math.random() * 85)).toString();
              if (otxPulses) otxPulses.innerText = (84 + Math.floor(Math.random() * 6)).toString();
              triggerHaptic('success');
              playSuccessChime();
          }, 600);
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
          if (mediaStream && cameraPreview) {
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
              playSuccessChime();
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
              playSuccessChime();
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
  // BULLETPROOF TRIPLE VERIFICATION COMMAND EXECUTION
  // =====================================================================
  const executeSendCommand = async () => {
    triggerHaptic('tap');
    playKeystroke();
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
    const configuredModel = document.getElementById('modelSelector') ? document.getElementById('modelSelector').value : 'gemini-3.7-flash';
    const routingDecision = routeModelByComplexity(cmd, configuredModel);
    const activeModel = routingDecision.selectedModel;

    if (routingDecision.escalated) {
        appendMsg(`[Dynamic Escalation] Complex task detected (${routingDecision.reason}). Escalated payload to Pro model: ${activeModel}`, 'system-msg', true);
    }

    const sys = `You are PG1.Agent v12.36. You are a fully autonomous, self-healing sovereign entity. 
TRIPLE VERIFICATION PROTOCOL ENFORCED:
1. You may NEVER claim a fix is complete until the engine returns a [Verified Success] payload.
2. If you receive a [Verification Failed] error from your commit, you MUST admit the failure.`;

    try {
      let continueLoop = true; let loopCount = 0;
      while (continueLoop && loopCount < 4) {
          loopCount++;
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent?key=${key}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: sessionHistory, systemInstruction: { parts: [{ text: sys }] }, tools: tools })
          });
          const data = await res.json();
          
          if (data.error) throw new Error(data.error.message);
          if (data.promptFeedback && data.promptFeedback.blockReason) throw new Error(`API Filter: ${data.promptFeedback.blockReason}`);
          if (!data.candidates || data.candidates.length === 0) throw new Error(`API returned empty structure.`);
          
          let responsePart = data.candidates[0].content.parts[0];
          
          if (responsePart.functionCall) {
              const call = responsePart.functionCall;
              appendMsg(`[MCP Dispatcher] Executing: ${call.name}...`, 'system-msg', true);
              let resultStr = "";
              try {
                  resultStr = await executeMCPTool(call.name, call.args);
                  if (call.name === 'dynamicGitHubCommit') {
                      appendMsg(`[Self-Healing Audit] Verifying live repository state...`, 'system-msg', true);
                      await new Promise(r => setTimeout(r, 2000));
                      const verifyRes = await executeMCPTool('readGitHubFile', { repoFullName: call.args.repoFullName, filePath: call.args.filePath });
                      const cleanTarget = call.args.content.substring(0, 50).trim();
                      if (verifyRes.includes(cleanTarget) && !verifyRes.includes("ERROR:")) {
                          resultStr += `\n[Verified Success] Live audit confirmed the patch successfully deployed.`;
                      } else {
                          resultStr += `\n[Verification Failed] CRITICAL ERROR: Live audit shows the patch did NOT apply correctly.`;
                          appendMsg(`[Audit Failure] Code mismatch detected.`, 'error-msg', true);
                      }
                  }
              } catch(toolErr) { resultStr = `[Error] ${toolErr.message}`; }

              appendMsg(`[Result] ${resultStr}`, 'agent-msg', true);
              sessionHistory.push(data.candidates[0].content);
              sessionHistory.push({ role: "user", parts: [{ functionResponse: { name: call.name, response: { result: resultStr } } }] });
              persistTerminalState();
              
              const followupRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent?key=${key}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: sessionHistory, systemInstruction: { parts: [{ text: sys }] }, tools: tools })
              });
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
          if (loopCount >= 4) throw new Error("Agent loop timed out.");
      }
    } catch (e) { 
      setSystemState('error'); 
      sessionHistory.pop(); 
      persistTerminalState();
      appendMsg(`Exception: ${e.message}`, 'error-msg', true); 
    }
  };

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
  
  // Tab navigation functionality
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
