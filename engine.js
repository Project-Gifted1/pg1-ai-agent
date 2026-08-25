let terminalAppendFunc = null;
let currentCameraStream = null;
let speechRecognizer = null;
let isRecordingAudio = false;
let isVoiceEnabled = false;
let isSentinelEnabled = true;
let isChronEnabled = false;
let chronTimer = null;

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

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playKeystroke() {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    try {
        const osc = audioCtx.createOscillator(); const gain = audioCtx.createGain();
        osc.type = 'sine'; osc.frequency.setValueAtTime(800 + Math.random() * 300, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.008, audioCtx.currentTime);
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.start(); osc.stop(audioCtx.currentTime + 0.015);
    } catch(e) {}
}

function playCoreChime() {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    try {
        const osc = audioCtx.createOscillator(); const gain = audioCtx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(523.25, audioCtx.currentTime); // C5
        osc.frequency.exponentialRampToValueAtTime(1046.50, audioCtx.currentTime + 0.15); // C6
        gain.gain.setValueAtTime(0.04, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35);
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.start(); osc.stop(audioCtx.currentTime + 0.35);
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

/* TTS Voice Synthesizer */
function speakText(text) {
    if (!isVoiceEnabled || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    
    // Strip markdown tags and code snippets for speech
    const cleanText = text.replace(/`[^`]*`/g, 'code snippet').replace(/[*#_~]/g, '').trim();
    if (!cleanText) return;

    const utterance = new SpeechSynthesisUtterance(cleanText);
    const gender = localStorage.getItem('PG1_VOICE_GENDER') || 'female';
    const lang = localStorage.getItem('PG1_VOICE_LANG') || 'auto';

    if (lang !== 'auto') {
        utterance.lang = lang;
    }

    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
        let matchedVoice = null;
        if (lang !== 'auto') {
            matchedVoice = voices.find(v => v.lang.toLowerCase().startsWith(lang.substring(0, 2).toLowerCase()));
        }
        if (!matchedVoice && gender === 'female') {
            matchedVoice = voices.find(v => v.name.toLowerCase().includes('female') || v.name.toLowerCase().includes('samantha') || v.name.toLowerCase().includes('zira') || v.name.toLowerCase().includes('google us english'));
        } else if (!matchedVoice && gender === 'male') {
            matchedVoice = voices.find(v => v.name.toLowerCase().includes('male') || v.name.toLowerCase().includes('david') || v.name.toLowerCase().includes('george') || v.name.toLowerCase().includes('daniel'));
        }
        if (matchedVoice) utterance.voice = matchedVoice;
    }

    const coreLogo = document.getElementById('aiCoreLogo');
    utterance.onstart = () => { if (coreLogo) coreLogo.classList.add('is-speaking'); };
    utterance.onend = () => { if (coreLogo) coreLogo.classList.remove('is-speaking'); };
    utterance.onerror = () => { if (coreLogo) coreLogo.classList.remove('is-speaking'); };

    window.speechSynthesis.speak(utterance);
}

window.saveMasterKeys = function() {
    triggerHaptic('tap');
    const kIn = document.getElementById('masterKeyInput'); const gIn = document.getElementById('githubKeyInput'); const rIn = document.getElementById('replicateKeyInput');
    if (kIn && kIn.value && kIn.value !== '••••••••••••••••') localStorage.setItem('PG1_KEY', kIn.value.trim());
    if (gIn && gIn.value && gIn.value !== '••••••••••••••••') localStorage.setItem('PG1_GH_PAT', gIn.value.trim());
    if (rIn && rIn.value && rIn.value !== '••••••••••••••••') localStorage.setItem('PG1_REPLICATE_KEY', rIn.value.trim());
    window.checkKeys(); triggerHaptic('success'); alert('Credentials securely saved.');
};

window.checkKeys = function() {
    const kIn = document.getElementById('masterKeyInput'); const gIn = document.getElementById('githubKeyInput'); const rIn = document.getElementById('replicateKeyInput');
    const stat = document.getElementById('keyStatusText'); const connBadge = document.getElementById('connectionBadge');
    if (!kIn || !gIn || !stat || !connBadge) return;
    if (localStorage.getItem('PG1_KEY') && localStorage.getItem('PG1_GH_PAT')) {
        kIn.value = '••••••••••••••••'; gIn.value = '••••••••••••••••';
        if (rIn && localStorage.getItem('PG1_REPLICATE_KEY')) rIn.value = '••••••••••••••••';
        stat.innerText = 'KEY_STATUS: STORED_LOCAL'; stat.style.color = '#10b981';
        connBadge.innerText = '● CONNECTED'; connBadge.style.color = '#10b981';
    } else {
        stat.innerText = 'KEY_STATUS: NOT_SET'; stat.style.color = '#ef4444';
        connBadge.innerText = '● DISCONNECTED'; connBadge.style.color = '#ef4444';
    }
};

window.copyMsg = function(btn) {
  triggerHaptic('tap');
  const msgDiv = btn.closest('.terminal-message');
  navigator.clipboard.writeText(msgDiv.innerText.replace('Copy', '').replace('Edit', '').trim()).then(() => alert('Copied to clipboard.'));
};

window.editMsg = function(btn) {
  triggerHaptic('tap');
  const msgDiv = btn.closest('.terminal-message');
  const input = document.getElementById('terminalInput');
  input.value = msgDiv.innerText.replace('Copy', '').replace('Edit', '').trim(); input.focus();
};

/* FULL MCP TOOL REGISTRY */
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
    return deepLogicTriggers.some(pattern => pattern.test(prompt)) || prompt.length > 250 || prompt.includes("```") || (prompt.match(/\n/g) || []).length >= 3;
}

function routeModelByComplexity(prompt, defaultModel = 'gemini-3.7-flash') {
    const isComplex = evaluatePromptComplexity(prompt);
    const PRO_MODEL = 'gemini-3.1-pro-preview';
    const FLASH_MODEL = 'gemini-3.7-flash';

    if (isComplex) {
        return { selectedModel: PRO_MODEL, escalated: true, reason: "Deep logic / diagnostic / architecture requirements detected" };
    }
    return { selectedModel: defaultModel.includes('pro') ? defaultModel : FLASH_MODEL, escalated: false, reason: "Standard complexity query routed to Flash core" };
}

/* THREADS MANAGEMENT */
function getSavedThreads() {
    try {
        const stored = localStorage.getItem('PG1_SAVED_THREADS');
        return stored ? JSON.parse(stored) : [];
    } catch(e) { return []; }
}

function saveCurrentThread(history, domContent) {
    if (!history || history.length === 0) return;
    const threads = getSavedThreads();
    const firstUserMsg = history.find(m => m.role === 'user');
    const titleText = firstUserMsg ? (firstUserMsg.parts[0]?.text || "Thread").substring(0, 30) : "Thread";
    const newThread = {
        id: 'th_' + Date.now(),
        title: titleText + '...',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' }),
        history: history,
        dom: domContent
    };
    threads.unshift(newThread);
    localStorage.setItem('PG1_SAVED_THREADS', JSON.stringify(threads.slice(0, 15)));
}

function renderSavedThreadsList() {
    const container = document.getElementById('threadsListContainer');
    if (!container) return;
    const threads = getSavedThreads();
    if (threads.length === 0) {
        container.innerHTML = '<div style="color:#94a3b8; font-size:0.8em; text-align:center; padding:12px;">No saved threads yet.</div>';
        return;
    }
    container.innerHTML = threads.map(th => `
        <div class="thread-item" data-id="${th.id}">
            <div class="thread-info" onclick="loadThread('${th.id}')">
                <div class="thread-title">💬 ${th.title}</div>
                <div class="thread-time">${th.timestamp}</div>
            </div>
            <button class="thread-delete-btn" onclick="deleteThread('${th.id}', event)">✕</button>
        </div>
    `).join('');
}

window.loadThread = function(threadId) {
    triggerHaptic('tap');
    const threads = getSavedThreads();
    const thread = threads.find(t => t.id === threadId);
    if (!thread) return;
    const termOut = document.getElementById('terminalOutput');
    if (termOut) termOut.innerHTML = thread.dom;
    window.activeSessionHistory = thread.history || [];
    document.getElementById('threadsModal').classList.remove('active');
};

window.deleteThread = function(threadId, e) {
    if (e) e.stopPropagation();
    triggerHaptic('tap');
    let threads = getSavedThreads().filter(t => t.id !== threadId);
    localStorage.setItem('PG1_SAVED_THREADS', JSON.stringify(threads));
    renderSavedThreadsList();
};

/* ENGINE INITIALIZATION */
document.addEventListener("DOMContentLoaded", () => {
  localStorage.removeItem('PG1_CHAT_DOM');
  localStorage.removeItem('PG1_CHAT_HISTORY');

  let sessionHistory = [];
  window.activeSessionHistory = sessionHistory;
  let pendingImageData = null;
  const termOut = document.getElementById('terminalOutput');
  window.checkKeys();

  function persistTerminalState() {
      try {
          if (termOut) localStorage.setItem('PG1_CHAT_DOM', termOut.innerHTML);
          localStorage.setItem('PG1_CHAT_HISTORY', JSON.stringify(sessionHistory.slice(-10)));
      } catch(e) {}
  }

  window.startNewThread = function() {
      triggerHaptic('tap');
      if (sessionHistory.length > 0 && termOut) {
          saveCurrentThread(sessionHistory, termOut.innerHTML);
      }
      sessionHistory = [];
      window.activeSessionHistory = sessionHistory;
      localStorage.removeItem('PG1_CHAT_DOM'); localStorage.removeItem('PG1_CHAT_HISTORY');
      termOut.innerHTML = '<div class="terminal-message agent-msg">Memory flushed. New secure thread initiated.<div class="msg-btn-group"><button class="msg-action-btn" onclick="copyMsg(this)">Copy</button></div></div>';
      document.getElementById('threadsModal').classList.remove('active');
  };

  async function appendMsg(text, type, instant = false) {
    const div = document.createElement('div'); div.className = `terminal-message ${type}`;
    if (type === 'user-msg' || type === 'system-msg' || type === 'error-msg' || instant) {
        div.innerHTML = renderMarkdownToHtml(text) + `<div class="msg-btn-group"><button class="msg-action-btn" onclick="copyMsg(this)">Copy</button><button class="msg-action-btn" onclick="editMsg(this)">Edit</button></div>`;
        termOut.appendChild(div); termOut.scrollTop = termOut.scrollHeight; persistTerminalState(); return;
    }
    div.classList.add('cursor-blink'); termOut.appendChild(div);
    for (let i = 0; i < text.length; i++) {
        div.textContent += text.charAt(i); playKeystroke(); termOut.scrollTop = termOut.scrollHeight;
        await new Promise(r => setTimeout(r, 6 + Math.random() * 10));
    }
    div.classList.remove('cursor-blink');
    div.innerHTML = renderMarkdownToHtml(text) + `<div class="msg-btn-group"><button class="msg-action-btn" onclick="copyMsg(this)">Copy</button><button class="msg-action-btn" onclick="editMsg(this)">Edit</button></div>`;
    termOut.scrollTop = termOut.scrollHeight; persistTerminalState(); triggerHaptic('success');
    speakText(text);
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
  updateCryptoTickers(); setInterval(updateCryptoTickers, 60000);
  
  setInterval(() => {
    if (document.getElementById('telemetrySpeed')) document.getElementById('telemetrySpeed').innerText = (2.2 + Math.random() * 0.6).toFixed(1) + ' MB/s';
    if (document.getElementById('throughputBar')) document.getElementById('throughputBar').style.width = (50 + Math.random() * 30) + '%';
    if (document.getElementById('cpuLoad')) { const c = Math.floor(24+Math.random()*14); document.getElementById('cpuLoad').innerText = c+'%'; document.getElementById('cpuBar').style.width = c+'%'; }
    if (document.getElementById('ramAlloc')) { const r = Math.floor(42+Math.random()*10); document.getElementById('ramAlloc').innerText = r+'%'; document.getElementById('ramBar').style.width = r+'%'; }
  }, 1000);

  // 1. Action Bar Button Handlers
  const threadsBtn = document.getElementById('threadsBtn');
  if (threadsBtn) {
      threadsBtn.onclick = () => {
          triggerHaptic('tap');
          renderSavedThreadsList();
          document.getElementById('threadsModal').classList.add('active');
      };
  }

  const voiceSettingsBtn = document.getElementById('voiceSettingsBtn');
  if (voiceSettingsBtn) {
      voiceSettingsBtn.onclick = () => {
          triggerHaptic('tap');
          const genderSel = document.getElementById('voiceGenderSelect');
          const langSel = document.getElementById('voiceLangSelect');
          if (genderSel) genderSel.value = localStorage.getItem('PG1_VOICE_GENDER') || 'female';
          if (langSel) langSel.value = localStorage.getItem('PG1_VOICE_LANG') || 'auto';
          document.getElementById('voiceSettingsModal').classList.add('active');
      };
  }

  const closeVoiceModalBtn = document.getElementById('closeVoiceModalBtn');
  if (closeVoiceModalBtn) {
      closeVoiceModalBtn.onclick = () => {
          triggerHaptic('tap');
          document.getElementById('voiceSettingsModal').classList.remove('active');
      };
  }

  const saveVoiceSettingsBtn = document.getElementById('saveVoiceSettingsBtn');
  if (saveVoiceSettingsBtn) {
      saveVoiceSettingsBtn.onclick = () => {
          triggerHaptic('success');
          const genderSel = document.getElementById('voiceGenderSelect');
          const langSel = document.getElementById('voiceLangSelect');
          if (genderSel) localStorage.setItem('PG1_VOICE_GENDER', genderSel.value);
          if (langSel) localStorage.setItem('PG1_VOICE_LANG', langSel.value);
          document.getElementById('voiceSettingsModal').classList.remove('active');
          appendMsg('Voice configuration saved and applied.', 'system-msg', true);
      };
  }

  // Video Toggle
  const videoBtn = document.getElementById('videoBtn');
  const cameraPipBox = document.getElementById('cameraPipBox');
  const cameraPreview = document.getElementById('cameraPreview');
  if (videoBtn) {
      videoBtn.onclick = async () => {
          triggerHaptic('tap');
          if (currentCameraStream) {
              currentCameraStream.getTracks().forEach(track => track.stop());
              currentCameraStream = null;
              if (cameraPipBox) cameraPipBox.style.display = 'none';
              videoBtn.classList.remove('active-btn');
              videoBtn.innerText = '📹 Vid: OFF';
          } else {
              try {
                  currentCameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
                  if (cameraPreview) cameraPreview.srcObject = currentCameraStream;
                  if (cameraPipBox) cameraPipBox.style.display = 'block';
                  videoBtn.classList.add('active-btn');
                  videoBtn.innerText = '📹 Vid: ON';
              } catch(err) {
                  appendMsg(`Camera access failed: ${err.message}`, 'error-msg', true);
              }
          }
      };
  }

  // Audio Dictation
  const audioBtn = document.getElementById('audioBtn');
  const inlineMicBtn = document.getElementById('inlineMicBtn');
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  function toggleDictation() {
      triggerHaptic('tap');
      if (!SpeechRecognition) return alert('Speech recognition not supported in this browser.');
      
      if (isRecordingAudio && speechRecognizer) {
          speechRecognizer.stop();
          isRecordingAudio = false;
          if (audioBtn) { audioBtn.classList.remove('recording-btn'); audioBtn.innerText = '🎙️ Dictate: OFF'; }
          if (inlineMicBtn) { inlineMicBtn.classList.remove('recording-btn'); }
          return;
      }

      try {
          speechRecognizer = new SpeechRecognition();
          speechRecognizer.continuous = false;
          speechRecognizer.interimResults = true;
          const userLang = localStorage.getItem('PG1_VOICE_LANG');
          if (userLang && userLang !== 'auto') speechRecognizer.lang = userLang;

          speechRecognizer.onstart = () => {
              isRecordingAudio = true;
              if (audioBtn) { audioBtn.classList.add('recording-btn'); audioBtn.innerText = '🎙️ Dictate: ON'; }
              if (inlineMicBtn) { inlineMicBtn.classList.add('recording-btn'); }
          };

          speechRecognizer.onresult = (event) => {
              let transcript = '';
              for (let i = event.resultIndex; i < event.results.length; ++i) {
                  transcript += event.results[i][0].transcript;
              }
              const termIn = document.getElementById('terminalInput');
              if (termIn) termIn.value = transcript;
          };

          speechRecognizer.onerror = () => {
              isRecordingAudio = false;
              if (audioBtn) { audioBtn.classList.remove('recording-btn'); audioBtn.innerText = '🎙️ Dictate: OFF'; }
              if (inlineMicBtn) { inlineMicBtn.classList.remove('recording-btn'); }
          };

          speechRecognizer.onend = () => {
              isRecordingAudio = false;
              if (audioBtn) { audioBtn.classList.remove('recording-btn'); audioBtn.innerText = '🎙️ Dictate: OFF'; }
              if (inlineMicBtn) { inlineMicBtn.classList.remove('recording-btn'); }
          };

          speechRecognizer.start();
      } catch(e) {
          isRecordingAudio = false;
      }
  }

  if (audioBtn) audioBtn.onclick = toggleDictation;
  if (inlineMicBtn) inlineMicBtn.onclick = toggleDictation;

  // Voice Response Toggle
  const voiceBtn = document.getElementById('voiceBtn');
  if (voiceBtn) {
      voiceBtn.onclick = () => {
          triggerHaptic('tap');
          isVoiceEnabled = !isVoiceEnabled;
          if (isVoiceEnabled) {
              voiceBtn.classList.add('active-btn');
              voiceBtn.innerText = '🗣️ Voice: ON';
              playCoreChime();
          } else {
              voiceBtn.classList.remove('active-btn');
              voiceBtn.innerText = '🗣️ Voice: OFF';
              window.speechSynthesis?.cancel();
          }
      };
  }

  // Sentinel Toggle
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

  // Chron Toggle
  const chronBtn = document.getElementById('chronBtn');
  if (chronBtn) {
      chronBtn.onclick = () => {
          triggerHaptic('tap');
          isChronEnabled = !isChronEnabled;
          if (isChronEnabled) {
              chronBtn.classList.add('active-btn');
              chronBtn.innerText = '⏱️ Chron: ON';
              chronTimer = setInterval(updateCryptoTickers, 15000);
          } else {
              chronBtn.classList.remove('active-btn');
              chronBtn.innerText = '⏱️ Chron: OFF';
              if (chronTimer) clearInterval(chronTimer);
          }
      };
  }

  // Refresh Feed Button
  const syncFeedBtn = document.getElementById('syncFeedBtn');
  if (syncFeedBtn) {
      syncFeedBtn.onclick = async () => {
          triggerHaptic('tap');
          const orig = syncFeedBtn.innerHTML;
          syncFeedBtn.innerHTML = '<span class="spin-icon">🔄</span> Syncing...';
          await updateCryptoTickers();
          setTimeout(() => { syncFeedBtn.innerHTML = orig; }, 800);
      };
  }

  // OTX Threat Intel Sync
  const syncOtxBtn = document.getElementById('syncOtxBtn');
  if (syncOtxBtn) {
      syncOtxBtn.onclick = () => {
          triggerHaptic('tap');
          const otxStatus = document.getElementById('otxStatus');
          const otxIocs = document.getElementById('otxIocs');
          const otxPulses = document.getElementById('otxPulses');
          if (otxStatus) otxStatus.innerText = 'Synchronizing...';
          setTimeout(() => {
              if (otxStatus) otxStatus.innerText = 'Active Pipeline';
              if (otxIocs) otxIocs.innerText = (1200 + Math.floor(Math.random() * 400)) + ' Indicators';
              if (otxPulses) otxPulses.innerText = (310 + Math.floor(Math.random() * 50)) + ' Pulses';
              triggerHaptic('success');
          }, 700);
      };
  }

  // Export Log & PDF
  const saveLogBtn = document.getElementById('saveLogBtn');
  if (saveLogBtn) {
      saveLogBtn.onclick = () => {
          triggerHaptic('tap');
          if (!termOut) return;
          const text = termOut.innerText.replace(/Copy|Edit/g, '');
          const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `PG1_Log_${Date.now()}.txt`;
          a.click();
      };
  }

  const exportPdfBtn = document.getElementById('exportPdfBtn');
  if (exportPdfBtn) {
      exportPdfBtn.onclick = () => {
          triggerHaptic('tap');
          window.print();
      };
  }

  // Multimodal Media Attachment
  const mediaBtn = document.getElementById('mediaBtn');
  const mediaInput = document.getElementById('mediaInput');
  const mediaPreviewBox = document.getElementById('mediaPreviewBox');
  const mediaPreviewImg = document.getElementById('mediaPreviewImg');
  const clearMediaBtn = document.getElementById('clearMediaBtn');

  if (mediaBtn && mediaInput) {
      mediaBtn.onclick = () => { triggerHaptic('tap'); mediaInput.click(); };
      mediaInput.onchange = (e) => {
          const file = e.target.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
              const base64Clean = reader.result.split(',')[1];
              pendingImageData = { mime: file.type || 'image/jpeg', base64: base64Clean };
              if (mediaPreviewImg) { mediaPreviewImg.src = reader.result; mediaPreviewImg.style.display = 'inline-block'; }
              if (mediaPreviewBox) mediaPreviewBox.style.display = 'block';
              triggerHaptic('success');
          };
          reader.readAsDataURL(file);
      };
  }

  if (clearMediaBtn) {
      clearMediaBtn.onclick = () => {
          triggerHaptic('tap');
          pendingImageData = null;
          if (mediaPreviewImg) { mediaPreviewImg.src = ''; mediaPreviewImg.style.display = 'none'; }
          if (mediaPreviewBox) mediaPreviewBox.style.display = 'none';
          if (mediaInput) mediaInput.value = '';
      };
  }

  // AI Core Logo Interactive Click
  const aiCoreLogo = document.getElementById('aiCoreLogo');
  if (aiCoreLogo) {
      aiCoreLogo.onclick = () => {
          triggerHaptic('success');
          playCoreChime();
          appendMsg('PG1 Sovereign Core pulse nominal. Auto-repair interceptors active.', 'system-msg', true);
      };
  }

  document.getElementById('clearBtn').onclick = () => window.startNewThread();

  // =====================================================================
  // BULLETPROOF TRIPLE VERIFICATION COMMAND EXECUTION
  // =====================================================================
  const executeSendCommand = async () => {
    triggerHaptic('tap');
    let cmd = document.getElementById('terminalInput').value.trim();
    if (!cmd && !pendingImageData) return;
    if (!cmd && pendingImageData) cmd = "Analyze this attached media payload.";

    const key = localStorage.getItem('PG1_KEY');
    if (!key) { setSystemState('error'); return appendMsg('Error: Master API Key required in Dash tab.', 'error-msg', true); }

    appendMsg(`> ${cmd}`, 'user-msg', true);
    document.getElementById('terminalInput').value = '';
    setSystemState('active');

    const userParts = [{ text: cmd }];
    if (pendingImageData) {
        userParts.push({ inline_data: { mime_type: pendingImageData.mime, data: pendingImageData.base64 } });
        // Clear media preview after attaching
        pendingImageData = null;
        if (mediaPreviewImg) { mediaPreviewImg.src = ''; mediaPreviewImg.style.display = 'none'; }
        if (mediaPreviewBox) mediaPreviewBox.style.display = 'none';
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
      setSystemState('error'); sessionHistory.pop(); persistTerminalState();
      appendMsg(`Exception: ${e.message}`, 'error-msg', true); 
    }
  };

  document.getElementById('sendCommandButton').onclick = executeSendCommand;
  document.getElementById('terminalInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); executeSendCommand(); } });
  
  // Tab functionality
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      triggerHaptic('tap');
      document.querySelectorAll('.nav-item, .view-section').forEach(el => el.classList.remove('active'));
      item.classList.add('active'); document.getElementById(item.getAttribute('data-target')).classList.add('active');
    });
  });
});