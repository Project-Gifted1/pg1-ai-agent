document.addEventListener("DOMContentLoaded", () => {
  const navItems = document.querySelectorAll('.nav-item');
  const views = document.querySelectorAll('.view-section');

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      navItems.forEach(nav => nav.classList.remove('active'));
      views.forEach(view => view.classList.remove('active'));

      item.classList.add('active');
      const targetId = item.getAttribute('data-target');
      document.getElementById(targetId).classList.add('active');
    });
  });

  const saveKeyBtn = document.getElementById('saveKeyButton');
  const keyInput = document.getElementById('masterKeyInput');
  const keyStatusText = document.getElementById('keyStatusText');

  saveKeyBtn.addEventListener('click', () => {
    const key = keyInput.value.trim();
    if (key) {
      localStorage.setItem('PG1_MASTER_KEY', key);
      keyStatusText.innerText = 'KEY_STATUS: STORED_LOCAL';
      keyStatusText.style.color = '#198754';
      alert('Sovereign Key Stored Locally.');
    }
  });

  if (localStorage.getItem('PG1_MASTER_KEY')) {
    keyStatusText.innerText = 'KEY_STATUS: STORED_LOCAL';
    keyStatusText.style.color = '#198754';
  } else {
    keyStatusText.innerText = 'KEY_STATUS: MISSING';
    keyStatusText.style.color = 'red';
  }

  const sendBtn = document.getElementById('sendCommandButton');
  const terminalInput = document.getElementById('terminalInput');
  const terminalOutput = document.getElementById('terminalOutput');
  const clearBtn = document.getElementById('clearTerminalBtn');

  const WORKER_URL = 'https://pg1-agent-worker.YOUR_SUBDOMAIN.workers.dev/'; 

  function appendMessage(text, type) {
    const msgDiv = document.createElement('div');
    msgDiv.classList.add('terminal-message', type);
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

  terminalInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendBtn.click();
  });
});
