let terminalAppendFunc = null;
let mediaStream = null;
let speechRecognizer = null;
let isVoiceEnabled = true;
let isSentinelEnabled = true;
let isChronEnabled = false;
let chronTimer = null;
let currentUtterance = null;
let speechKeepAliveInterval = null;
let audioCtx = null;
let isSpeakingNow = false;

function getAudioContext() {
    if (!audioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) audioCtx = new AudioContextClass();
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
        if (type === 'tap') navigator.vibrate(15);
        if (type === 'success') navigator.vibrate([25, 40, 25]);
        if (type === 'error') navigator.vibrate([60, 40, 60, 40, 100]);
    } catch(e) {}
}

function setSystemState(state) {
    document.body.className = '';
    if (state === 'active') document.body.classList.add('sys-active');
    if (state === 'error') { document.body.classList.add('sys-error'); triggerHaptic('error'); }
}

function playKeystroke() {
    try {
        const ctx = getAudioContext();
        if (!ctx) return;
        const osc = ctx.createOscillator(); 
        const gain = ctx.createGain();
        osc.type = 'sine'; 
        osc.frequency.setValueAtTime(800 + Math.random() * 300, ctx.currentTime);
        gain.gain.setValueAtTime(0.008, ctx.currentTime);
        osc.connect(gain); 
        gain.connect(ctx.destination);
        osc.start(); 
        osc.stop(ctx.currentTime + 0.015);
    } catch(e) {}
}

function playNotificationChime() {
    try {
        unlockAudio();
        const ctx = getAudioContext();
        if (!ctx) return;
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(587.33, now); // D5
        osc.frequency.setValueAtTime(880, now + 0.08); // A5
        gain.gain.setValueAtTime(0.05, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.35);
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
  navigator.clipboard.writeText(clone.innerText.trim()).then(() => alert('Copied to clipboard.'));
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

/* PRE-LOAD VOICES */
let systemVoices = [];
function cacheSystemVoices() {
    if ('speechSynthesis' in window) {
        systemVoices = window.speechSynthesis.getVoices();
    }
}
if ('speechSynthesis' in window) {
    cacheSystemVoices();
    window.speechSynthesis.onvoiceschanged = cacheSystemVoices;
}

/* ROBUST VOICE SYNTHESIS ENGINE (iOS & Safari Compatible) */
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
            .trim();

        if (!plainText) return;

        // Split text into digestible chunks for mobile Web Speech API reliability
        const sentenceRegex = /[^.!?]+[.!?]+|[^.!?]+$/g;
        const chunks = plainText.match(sentenceRegex) || [plainText];
        let chunkIndex = 0;

        const savedLang = localStorage.getItem('PG1_VOICE_LANG') || 'en-US';
        const savedGender = localStorage.getItem('PG1_VOICE_GENDER') || 'female';

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
            utterance.rate = 1.05;
            utterance.pitch = 1.0;

            if (savedLang !== 'auto') {
                utterance.lang = savedLang;
            }

            const voices = (systemVoices && systemVoices.length > 0) ? systemVoices : window.speechSynthesis.getVoices();
            if (voices && voices.length > 0) {
                let matchedVoice = null;
                const langPrefix = savedLang === 'auto' ? 'en' : savedLang.substring(0, 2);
                if (savedGender === 'male') {
                    matchedVoice = voices.find(v => (v.lang.startsWith(langPrefix) || savedLang === 'auto') && (v.name.toLowerCase().includes('male') || v.name.toLowerCase().includes('david') || v.name.toLowerCase().includes('guy') || v.name.toLowerCase().includes('george') || v.name.toLowerCase().includes('daniel') || v.name.toLowerCase().includes('alex') || v.name.toLowerCase().includes('aaron')));
                } else if (savedGender === 'female') {
                    matchedVoice = voices.find(v => (v.lang.startsWith(langPrefix) || savedLang === 'auto') && (v.name.toLowerCase().includes('female') || v.name.toLowerCase().includes('zira') || v.name.toLowerCase().includes('samantha') || v.name.toLowerCase().includes('victoria') || v.name.toLowerCase().includes('karen') || v.name.toLowerCase().includes('siri') || v.name.toLowerCase().includes('moira') || v.name.toLowerCase().includes('tessa')));
                }
                if (!matchedVoice) {
                    matchedVoice = voices.find(v => v.lang.startsWith(langPrefix));
                }
                if (matchedVoice) utterance.voice = matchedVoice;
            }

            const logo = document.getElementById('aiCoreLogo');
            utterance.onstart = () => {
                isSpeakingNow = true;
                if (logo) logo.classList.add('is-speaking');
            };

            utterance.onend = () => {
                speakNextChunk();
            };

            utterance.onerror = (e) => {
                speakNextChunk();
            };

            currentUtterance = utterance;
            window.speechSynthesis.speak(utterance);
        }

        // Keep-alive timer for WebKit speech synthesis
        speechKeepAliveInterval = setInterval(() => {
            if (window.speechSynthesis.speaking) {
                window.speechSynthesis.resume();
            } else if (!isSpeakingNow) {
                clearInterval(speechKeepAliveInterval);
                speechKeepAliveInterval = null;
            }
        }, 5000);

        playNotificationChime();
        speakNextChunk();
    } catch(e) {}
}

/* FULL MCP TOOL REGISTRY RESTORED */
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

/* ENGINE INITIALIZATION */
document.addEventListener("DOMContentLoaded", () => {
  localStorage.removeItem('PG1_CHAT_DOM');
  localStorage.removeItem('PG1_CHAT_HISTORY');

  let sessionHistory = [];
  let pendingImageData = null;
  const termOut = document.getElementById('terminalOutput');
  window.checkKeys(); 

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
        await new Promise(r => setTimeout(r, 6 + Math.random() * 10));
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

  /* ACTION BAR & MODAL ICON BUTTON HANDLERS */
  const threadsBtn = document.getElementById('threadsBtn');
  const threadsModal = document.getElementById('threadsModal');
  if (threadsBtn && threadsModal) {
      threadsBtn.onclick = () => {
          triggerHaptic('tap');
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

  if (voiceGenderSelect && localStorage.getItem('PG1_VOICE_GENDER')) {
      voiceGenderSelect.value = localStorage.getItem('PG1_VOICE_GENDER');
  }
  if (voiceLangSelect && localStorage.getItem('PG1_VOICE_LANG')) {
      voiceLangSelect.value = localStorage.getItem('PG1_VOICE_LANG');
  }

  if (voiceSettingsBtn && voiceSettingsModal) {
      voiceSettingsBtn.onclick = () => {
          triggerHaptic('tap');
          unlockAudio();
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
      saveVoiceSettingsBtn.onclick = () => {
          triggerHaptic('tap');
          unlockAudio();
          if (voiceGenderSelect) localStorage.setItem('PG1_VOICE_GENDER', voiceGenderSelect.value);
          if (voiceLangSelect) localStorage.setItem('PG1_VOICE_LANG', voiceLangSelect.value);
          voiceSettingsModal.classList.remove('active');
          triggerHaptic('success');
          speakAgentResponse("Neural voice updated. Systems operational.", true);
      };
  }
  if (testVoiceBtn) {
      testVoiceBtn.onclick = () => {
          triggerHaptic('tap');
          unlockAudio();
          if (voiceGenderSelect) localStorage.setItem('PG1_VOICE_GENDER', voiceGenderSelect.value);
          if (voiceLangSelect) localStorage.setItem('PG1_VOICE_LANG', voiceLangSelect.value);
          speakAgentResponse("Project Gifted 1 Sovereign Voice synthesizer test successful.", true);
      };
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
              speakAgentResponse('Voice active and sound verified.', true);
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

  /* AUDIO DICTATION SPEECH RECOGNITION */
  const audioBtn = document.getElementById('audioBtn');
  const inlineMicBtn = document.getElementById('inlineMicBtn');
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

  function toggleSpeechRecognition() {
      triggerHaptic('tap');
      unlockAudio();
      if (!SpeechRec) {
          alert('Speech Recognition API not supported in this browser.');
          return;
      }
      if (speechRecognizer) {
          speechRecognizer.stop();
          speechRecognizer = null;
          if (audioBtn) { audioBtn.classList.remove('recording-btn'); audioBtn.innerText = '🎙️ Dictate: OFF'; }
          if (inlineMicBtn) inlineMicBtn.classList.remove('recording-btn');
          return;
      }
      try {
          speechRecognizer = new SpeechRec();
          speechRecognizer.continuous = false;
          speechRecognizer.interimResults = false;
          speechRecognizer.lang = localStorage.getItem('PG1_VOICE_LANG') && localStorage.getItem('PG1_VOICE_LANG') !== 'auto' ? localStorage.getItem('PG1_VOICE_LANG') : 'en-US';
          
          if (audioBtn) { audioBtn.classList.add('recording-btn'); audioBtn.innerText = '🎙️ Dictate: REC'; }
          if (inlineMicBtn) inlineMicBtn.classList.add('recording-btn');

          speechRecognizer.onresult = (event) => {
              const transcript = event.results[0][0].transcript;
              const input = document.getElementById('terminalInput');
              if (input) {
                  input.value = (input.value ? input.value + ' ' : '') + transcript;
                  input.focus();
              }
              triggerHaptic('success');
          };

          speechRecognizer.onerror = () => {
              if (audioBtn) { audioBtn.classList.remove('recording-btn'); audioBtn.innerText = '🎙️ Dictate: OFF'; }
              if (inlineMicBtn) inlineMicBtn.classList.remove('recording-btn');
              speechRecognizer = null;
          };

          speechRecognizer.onend = () => {
              if (audioBtn) { audioBtn.classList.remove('recording-btn'); audioBtn.innerText = '🎙️ Dictate: OFF'; }
              if (inlineMicBtn) inlineMicBtn.classList.remove('recording-btn');
              speechRecognizer = null;
          };

          speechRecognizer.start();
      } catch(e) {
          alert('Microphone initialization failed.');
      }
  }

  if (audioBtn) audioBtn.onclick = toggleSpeechRecognition;
  if (inlineMicBtn) inlineMicBtn.onclick = toggleSpeechRecognition;

  /* DASH FEED & OTX SYNC BUTTONS */
  const syncFeedBtn = document.getElementById('syncFeedBtn');
  if (syncFeedBtn) {
      syncFeedBtn.onclick = async () => {
          triggerHaptic('tap');
          syncFeedBtn.disabled = true;
          await updateCryptoTickers();
          triggerHaptic('success');
          setTimeout(() => { syncFeedBtn.disabled = false; }, 800);
      };
  }

  const syncOtxBtn = document.getElementById('syncOtxBtn');
  if (syncOtxBtn) {
      syncOtxBtn.onclick = () => {
          triggerHaptic('tap');
          const otxStatus = document.getElementById('otxStatus');
          const otxIocs = document.getElementById('otxIocs');
          const otxPulses = document.getElementById('otxPulses');
          if (otxStatus) otxStatus.innerText = 'Syncing...';
          setTimeout(() => {
              if (otxStatus) otxStatus.innerText = 'Active (Synced)';
              if (otxIocs) otxIocs.innerText = (1420 + Math.floor(Math.random() * 85)).toString();
              if (otxPulses) otxPulses.innerText = (84 + Math.floor(Math.random() * 6)).toString();
              triggerHaptic('success');
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
          };
          reader.readAsDataURL(file);
      };
  }

  if (clearMediaBtn && mediaPreviewBox) {
      clearMediaBtn.onclick = () => {
          triggerHaptic('tap');
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
      };
  }

  const exportPdfBtn = document.getElementById('exportPdfBtn');
  if (exportPdfBtn) {
      exportPdfBtn.onclick = () => {
          triggerHaptic('tap');
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
    unlockAudio();
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
      document.querySelectorAll('.nav-item, .view-section').forEach(el => el.classList.remove('active'));
      item.classList.add('active'); 
      const targetSection = document.getElementById(item.getAttribute('data-target'));
      if (targetSection) targetSection.classList.add('active');
    });
  });
});
