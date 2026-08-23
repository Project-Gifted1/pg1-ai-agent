document.addEventListener("DOMContentLoaded", () => {
  // --- View Switching Logic ---
  const navItems = document.querySelectorAll('.nav-item');
  const views = document.querySelectorAll('.view-section');

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      // Remove active class from all nav items and views
      navItems.forEach(nav => nav.classList.remove('active'));
      views.forEach(view => view.classList.remove('active'));

      // Add active class to clicked item and corresponding view
      item.classList.add('active');
      const targetId = item.getAttribute('data-target');
      document.getElementById(targetId).classList.add('active');
    });
  });

  // --- Key Relay Logic ---
  const saveKeyBtn = document.getElementById('saveKeyButton');
  const keyInput = document.getElementById('masterKeyInput');
  const keyStatusText = document.getElementById('keyStatusText');

  saveKeyBtn.addEventListener('click', () => {
    const key = keyInput.value.trim();
    if (key) {
      localStorage.setItem('PG1_MASTER_KEY', key);
      keyStatusText.innerText = 'KEY_STATUS: STORED_LOCAL';
      alert('Sovereign Key Stored Locally.');
    }
  });

  // Load key on init if it exists
  if (localStorage.getItem('PG1_MASTER_KEY')) {
    keyStatusText.innerText = 'KEY_STATUS: STORED_LOCAL';
  } else {
    keyStatusText.innerText = 'KEY_STATUS: MISSING';
    keyStatusText.style.color = 'red';
  }

  // --- Terminal Execution Logic ---
  const sendBtn = document.getElementById('sendCommandButton');
  const terminalInput = document.getElementById('terminalInput');
  const terminalOutput = document.getElementById('terminalOutput');
  const clearBtn = document.getElementById('clearTerminalBtn');

  // Replace this with your actual deployed worker URL from yesterday
  const WORKER_URL = 'https://pg1-worker.YOUR_CLOUDFLARE_SUBDOMAIN.workers.dev/'; 

  function appendMessage(text, type) {
    const msgDiv = document.createElement('div');
    msgDiv.classList.add('terminal-message', type);
    // Replace newlines with <br> for terminal output formatting
    msgDiv.innerHTML = text.replace(/\n/g, '<br>'); 
    terminalOutput.appendChild(msgDiv);
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
  }

  clearBtn.addEventListener('click', () => {
    terminalOutput.innerHTML = '<div class="terminal-message system-msg">Terminal cleared.</div>';
  });

  sendBtn.addEventListener('click', async () => {
    const command = terminalInput.value.trim();
    if (!command) return;

    appendMessage(`> ${command}`, 'user-msg');
    terminalInput.value = '';
    
    // We get the local key, but since your worker already has GEMINI_API_KEY as an env secret,
    // this header is optional unless you designed the worker to strictly require it.
    const masterKey = localStorage.getItem('PG1_MASTER_KEY') || "";

    try {
      const response = await fetch(WORKER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${masterKey}` 
        },
        body: JSON.stringify({ command })
      });

      if (!response.ok) {
        throw new Error(`Server returned status ${response.status}`);
      }

      const data = await response.json();
      
      if (data.error) {
        appendMessage(`Agent Error: ${data.error}`, 'error-msg');
      } else {
        appendMessage(data.response, 'agent-msg');
      }
    } catch (error) {
      appendMessage(`Connection Failure: ${error.message}. Ensure WORKER_URL in app.js is correct.`, 'error-msg');
    }
  });

  // Allow sending via Enter key
  terminalInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendBtn.click();
  });
});
