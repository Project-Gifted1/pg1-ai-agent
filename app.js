// app.js - Full Sovereign Engine Frontend Agent Handler
document.addEventListener('DOMContentLoaded', () => {
    const sendButton = document.querySelector('button#send, .send-btn, #send-btn') || document.querySelector('button:has-text("Send"), button');
    const inputField = document.querySelector('input[type="text"], textarea, #user-input');
    const terminalContainer = document.querySelector('.terminal-container, #terminal, .chat-thread');

    if (!inputField) return;

    async function handleAgentDispatch() {
        const promptText = inputField.value.trim();
        if (!promptText) return;

        // Append user card
        appendCard('user', promptText);
        inputField.value = '';

        try {
            const apiKey = localStorage.getItem('gemini_api_key') || prompt("Enter Gemini API Key:");
            if (apiKey) localStorage.setItem('gemini_api_key', apiKey);

            const response = await fetch('https://project-gifted1-worker.workers.dev', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Gemini-API-Key': apiKey
                },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: promptText }] }]
                })
            });

            const data = await response.json();
            
            let agentResponse = "Engine operational.";
            if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                agentResponse = data.candidates[0].content.parts[0].text;
            } else if (data?.error) {
                agentResponse = `Error: ${data.error}`;
            }

            appendCard('agent', agentResponse);
        } catch (err) {
            appendCard('agent', `Sovereign Engine Error: ${err.message}`);
        }
    }

    function appendCard(sender, text) {
        if (!terminalContainer) return;
        const card = document.createElement('div');
        card.className = `terminal-card ${sender}-card`;
        card.style.margin = "10px 0";
        card.style.padding = "12px";
        card.style.borderRadius = "8px";
        card.style.background = sender === 'user' ? '#f0f4f8' : '#ffffff';
        card.style.border = "1px solid #d1d5db";
        card.innerText = text;
        terminalContainer.appendChild(card);
        terminalContainer.scrollTop = terminalContainer.scrollHeight;
    }

    // Attach event listeners
    if (sendButton) {
        sendButton.addEventListener('click', handleAgentDispatch);
    }
    inputField.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleAgentDispatch();
    });
});
