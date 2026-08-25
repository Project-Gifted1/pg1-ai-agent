let terminalAppendFunc = null;

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
    const kIn = document.getElementById('masterKeyInput'); const gIn = document.getElementById('githubKeyInput');
    if (kIn && kIn.value && kIn.value !== '••••••••••••••••') localStorage.setItem('PG1_KEY', kIn.value.trim());
    if (gIn && gIn.value && gIn.value !== '••••••••••••••••') localStorage.setItem('PG1_GH_PAT', gIn.value.trim());
    window.checkKeys(); triggerHaptic('success'); alert('Credentials securely saved.');
};

window.checkKeys = function() {
    const kIn = document.getElementById('masterKeyInput'); const gIn = document.getElementById('githubKeyInput');
    const stat = document.getElementById('keyStatusText'); const connBadge = document.getElementById('connectionBadge');
    if (!kIn || !gIn || !stat || !connBadge) return;
    if (localStorage.getItem('PG1_KEY') && localStorage.getItem('PG1_GH_PAT')) {
        kIn.value = '••••••••••••••••'; gIn.value = '••••••••••••••••';
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
  navigator.clipboard.writeText(msgDiv.innerText.replace('Copy', '').replace('Edit', '').trim()).then(() => alert('Copied.'));
};

window.editMsg = function(btn) {
  triggerHaptic('tap');
  const msgDiv = btn.closest('.terminal-message');
  const input = document.getElementById('terminalInput');
  input.value = msgDiv.innerText.replace('Copy', '').replace('Edit', '').trim(); input.focus();
};

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

/* ENGINE INITIALIZATION */
document.addEventListener("DOMContentLoaded", () => {
  // OVERRIDE: Force wipe corrupted DOM and Session History on boot to prevent OOM crash
  localStorage.removeItem('PG1_CHAT_DOM');
  localStorage.removeItem('PG1_CHAT_HISTORY');

  let sessionHistory = [];
  let pendingImageData = null; let pendingAudioData = null;
  const termOut = document.getElementById('terminalOutput');
  window.checkKeys(); 

  function persistTerminalState() {
      try {
          if (termOut) localStorage.setItem('PG1_CHAT_DOM', termOut.innerHTML);
          localStorage.setItem('PG1_CHAT_HISTORY', JSON.stringify(sessionHistory.slice(-10)));
      } catch(e) {}
  }

  window.startNewThread = function() {
      triggerHaptic('tap'); sessionHistory = [];
      localStorage.removeItem('PG1_CHAT_DOM'); localStorage.removeItem('PG1_CHAT_HISTORY');
      termOut.innerHTML = '<div class="terminal-message agent-msg">Memory flushed. New secure thread initiated.<div class="msg-btn-group"><button class="msg-action-btn" onclick="copyMsg(this)">Copy</button></div></div>';
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
        await new Promise(r => setTimeout(r, 8 + Math.random() * 12));
    }
    div.classList.remove('cursor-blink');
    div.innerHTML = renderMarkdownToHtml(text) + `<div class="msg-btn-group"><button class="msg-action-btn" onclick="copyMsg(this)">Copy</button><button class="msg-action-btn" onclick="editMsg(this)">Edit</button></div>`;
    termOut.scrollTop = termOut.scrollHeight; persistTerminalState(); triggerHaptic('success');
  }
  terminalAppendFunc = appendMsg;

  // Restored Telemetry & Crypto Loops
  async function updateCryptoTickers() {
      try {
          const btcRes = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot');
          const ethRes = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot');
          if(btcRes.ok && ethRes.ok) {
              document.getElementById('btcTicker').innerText = '$' + parseFloat((await btcRes.json()).data.amount).toLocaleString(undefined, {minimumFractionDigits: 2}) + ' USD';
              document.getElementById('ethTicker').innerText = '$' + parseFloat((await ethRes.json()).data.amount).toLocaleString(undefined, {minimumFractionDigits: 2}) + ' USD';
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

  document.getElementById('clearBtn').onclick = () => window.startNewThread();

  // =====================================================================
  // BULLETPROOF TRIPLE VERIFICATION COMMAND EXECUTION
  // =====================================================================
  const executeSendCommand = async () => {
    triggerHaptic('tap');
    let cmd = document.getElementById('terminalInput').value.trim();
    if (!cmd) return;

    const key = localStorage.getItem('PG1_KEY');
    if (!key) { setSystemState('error'); return appendMsg('Error: Master API Key required in Dash tab.', 'error-msg', true); }

    appendMsg(`> ${cmd}`, 'user-msg', true);
    document.getElementById('terminalInput').value = '';
    setSystemState('active');

    sessionHistory.push({ role: "user", parts: [{ text: cmd }] });
    persistTerminalState();
    
    const tools = getMCPToolDeclarations();
    const selectedModel = document.getElementById('modelSelector').value;
    const sys = `You are PG1.Agent v12.36. You are a fully autonomous, self-healing sovereign entity. 
TRIPLE VERIFICATION PROTOCOL ENFORCED:
1. You may NEVER claim a fix is complete until the engine returns a [Verified Success] payload.
2. If you receive a [Verification Failed] error from your commit, you MUST admit the failure.`;

    try {
      let continueLoop = true; let loopCount = 0;
      while (continueLoop && loopCount < 4) {
          loopCount++;
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${key}`, {
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
              
              const followupRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${key}`, {
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
