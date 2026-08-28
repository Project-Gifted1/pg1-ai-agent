(function () {
  var chatEl = document.getElementById('chat');
  var inputEl = document.getElementById('promptInput');
  var sendBtn = document.getElementById('sendBtn');
  var micBtn = document.getElementById('micBtn');
  var imageBtn = document.getElementById('imageBtn');
  var videoBtn = document.getElementById('videoBtn');
  var voiceBtn = document.getElementById('voiceBtn');
  var imageInput = document.getElementById('imageInput');
  var videoInput = document.getElementById('videoInput');
  var statusEl = document.getElementById('status');
  var statusBadgeEl = document.getElementById('statusBadge');
  var attachmentDockEl = document.getElementById('attachmentDock');
  var enginePill = document.getElementById('enginePill');
  var modalOverlay = document.getElementById('modalOverlay');
  var modalClose = document.getElementById('modalClose');
  var quickButtons = Array.prototype.slice.call(document.querySelectorAll('[data-quick-prompt]'));
  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!chatEl || !inputEl || !sendBtn || !statusEl || !statusBadgeEl || !attachmentDockEl) {
    return;
  }

  var state = {
    listening: false,
    recognition: null,
    pendingAttachments: [],
    lastAssistantReply: '',
    ttsEnabled: 'speechSynthesis' in window,
    speaking: false
  };

  function setStatus(text, badgeText) {
    statusEl.textContent = text;
    statusBadgeEl.textContent = badgeText || text;
  }

  function autoResizeTextarea() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(Math.max(inputEl.scrollHeight, 44), 152) + 'px';
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function parseMarkdown(markdown) {
    var codeBlocks = [];
    var source = String(markdown || '').replace(/```([\s\S]*?)```/g, function (_, code) {
      var token = '%%PG1_CODE_BLOCK_' + codeBlocks.length + '%%';
      codeBlocks.push('<pre><code>' + escapeHtml(code.trim()) + '</code></pre>');
      return token;
    });
    var text = escapeHtml(source);

    text = text.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
    text = text.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
    text = text.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
    text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');

    var lines = text.split('\n');
    var output = [];
    var inList = false;

    lines.forEach(function (line) {
      if (/^\s*[-*]\s+/.test(line)) {
        if (!inList) {
          inList = true;
          output.push('<ul>');
        }
        output.push('<li>' + line.replace(/^\s*[-*]\s+/, '') + '</li>');
        return;
      }

      if (inList) {
        inList = false;
        output.push('</ul>');
      }

      if (!line.trim()) {
        output.push('');
        return;
      }

      if (/^<h[1-3]>.*<\/h[1-3]>$/.test(line) || /^<pre>/.test(line)) {
        output.push(line);
        return;
      }

      output.push('<p>' + line + '</p>');
    });

    if (inList) output.push('</ul>');
    return output.filter(Boolean).join('').replace(/%%PG1_CODE_BLOCK_(\d+)%%/g, function (_, index) {
      return codeBlocks[Number(index)] || '';
    });
  }

  function formatFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return 'Queued';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function stopSpeech() {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    state.speaking = false;
    updateVoiceButton();
  }

  function speak(text, forceReplay) {
    if (!('speechSynthesis' in window)) {
      setStatus('Voice playback is not supported in this browser.', 'Voice unavailable');
      return;
    }

    var cleanText = String(text || '').replace(/[#>*_`\-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!cleanText) return;
    if (!state.ttsEnabled && !forceReplay) return;

    stopSpeech();
    var utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.volume = 1;
    utterance.onstart = function () {
      state.speaking = true;
      updateVoiceButton();
      setStatus('Speaking latest response…', 'Speaking');
    };
    utterance.onend = function () {
      state.speaking = false;
      updateVoiceButton();
      setStatus('Ready', 'Ready');
    };
    utterance.onerror = function () {
      state.speaking = false;
      updateVoiceButton();
      setStatus('Voice playback failed. Try again.', 'Voice error');
    };

    window.speechSynthesis.speak(utterance);
  }

  function updateVoiceButton() {
    if (!voiceBtn) return;
    voiceBtn.classList.toggle('is-active', state.ttsEnabled || state.speaking);
    voiceBtn.classList.toggle('is-muted', !state.ttsEnabled && !state.speaking);
    voiceBtn.setAttribute('aria-pressed', state.ttsEnabled ? 'true' : 'false');
    var label = state.speaking ? 'Stop voice playback' : (state.ttsEnabled ? 'Mute voice playback' : 'Enable voice playback');
    voiceBtn.setAttribute('aria-label', label);
    voiceBtn.title = label;
    var labelEl = voiceBtn.querySelector('.tool-label');
    if (labelEl) {
      labelEl.textContent = state.speaking ? 'Stop' : (state.ttsEnabled ? 'Voice on' : 'Voice off');
    }
  }

  function setListeningState(isListening) {
    state.listening = isListening;
    if (!micBtn) return;
    micBtn.classList.toggle('listening', isListening);
    micBtn.classList.toggle('is-active', isListening);
    micBtn.setAttribute('aria-label', isListening ? 'Stop microphone input' : 'Start microphone input');
    micBtn.title = isListening ? 'Stop microphone input' : 'Start microphone input';
    var labelEl = micBtn.querySelector('.tool-label');
    if (labelEl) {
      labelEl.textContent = isListening ? 'Listening' : 'Mic';
    }
    setStatus(isListening ? 'Listening for your prompt…' : 'Ready', isListening ? 'Listening' : 'Ready');
  }

  function revokeAttachmentUrl(attachment) {
    if (attachment && attachment.previewUrl) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  }

  function renderAttachments() {
    attachmentDockEl.innerHTML = '';
    attachmentDockEl.hidden = state.pendingAttachments.length === 0;

    state.pendingAttachments.forEach(function (attachment) {
      var card = document.createElement('div');
      card.className = 'attachment-card';

      var top = document.createElement('div');
      top.className = 'attachment-top';

      var kind = document.createElement('div');
      kind.className = 'attachment-kind';
      kind.textContent = attachment.kind;
      top.appendChild(kind);

      var removeBtn = document.createElement('button');
      removeBtn.className = 'attachment-remove';
      removeBtn.type = 'button';
      removeBtn.setAttribute('aria-label', 'Remove ' + attachment.kind.toLowerCase());
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', function () {
        removeAttachment(attachment.id);
      });
      top.appendChild(removeBtn);
      card.appendChild(top);

      var preview;
      if (attachment.type.indexOf('video/') === 0) {
        preview = document.createElement('video');
        preview.src = attachment.previewUrl;
        preview.controls = true;
        preview.playsInline = true;
        preview.preload = 'metadata';
      } else {
        preview = document.createElement('img');
        preview.src = attachment.previewUrl;
        preview.alt = attachment.name;
      }
      card.appendChild(preview);

      var name = document.createElement('div');
      name.className = 'attachment-name';
      name.textContent = attachment.name;
      card.appendChild(name);

      var meta = document.createElement('div');
      meta.className = 'attachment-meta';
      meta.textContent = formatFileSize(attachment.size) + ' • ready to send';
      card.appendChild(meta);

      attachmentDockEl.appendChild(card);
    });
  }

  function removeAttachment(id) {
    state.pendingAttachments = state.pendingAttachments.filter(function (attachment) {
      if (attachment.id === id) {
        revokeAttachmentUrl(attachment);
        return false;
      }
      return true;
    });
    renderAttachments();
    setStatus(state.pendingAttachments.length ? 'Media updated.' : 'Media cleared.', state.pendingAttachments.length ? 'Queued' : 'Ready');
  }

  function addAttachment(file, kind) {
    if (!file) return;
    var attachment = {
      id: kind + ':' + Date.now(),
      kind: kind,
      name: file.name || (kind.toLowerCase() + '-capture'),
      type: file.type || (kind === 'Video' ? 'video/mp4' : 'image/jpeg'),
      size: file.size || 0,
      previewUrl: URL.createObjectURL(file)
    };

    state.pendingAttachments = state.pendingAttachments.filter(function (entry) {
      if (entry.kind === kind) {
        revokeAttachmentUrl(entry);
        return false;
      }
      return true;
    });
    state.pendingAttachments.push(attachment);
    renderAttachments();
    setStatus(kind + ' ready to send.', 'Media ready');
  }

  function buildAttachmentSummary() {
    if (!state.pendingAttachments.length) return '';
    return state.pendingAttachments.map(function (attachment) {
      return '- ' + attachment.kind + ': ' + attachment.name + ' (' + attachment.type + ')';
    }).join('\n');
  }

  function cloneAttachmentPayload() {
    return state.pendingAttachments.map(function (attachment) {
      return {
        kind: attachment.kind.toLowerCase(),
        name: attachment.name,
        type: attachment.type,
        size: attachment.size
      };
    });
  }

  function buildInlineMedia(attachments) {
    if (!attachments || !attachments.length) return null;
    var wrap = document.createElement('div');
    wrap.className = 'inline-media';

    attachments.forEach(function (attachment) {
      var card = document.createElement('div');
      card.className = 'inline-media-card';
      var media;
      if (attachment.type && attachment.type.indexOf('video/') === 0) {
        media = document.createElement('video');
        media.src = attachment.previewUrl;
        media.controls = true;
        media.playsInline = true;
        media.preload = 'metadata';
      } else {
        media = document.createElement('img');
        media.src = attachment.previewUrl;
        media.alt = attachment.name || attachment.kind;
      }
      card.appendChild(media);

      var label = document.createElement('div');
      label.className = 'inline-media-name';
      label.textContent = attachment.name || attachment.kind;
      card.appendChild(label);

      wrap.appendChild(card);
    });

    return wrap;
  }

  function appendMessage(role, rawText, attachments, metaLabel) {
    var wrapper = document.createElement('div');
    wrapper.className = 'msg-wrapper';

    var meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.innerHTML = role === 'assistant'
      ? '<span class="meta-tag">PG1</span><span>•</span><span>' + escapeHtml(metaLabel || 'Response ready') + '</span>'
      : '<span class="meta-tag">You</span><span>•</span><span>' + escapeHtml(metaLabel || 'Prompt queued') + '</span>';

    var message = document.createElement('div');
    message.className = 'message ' + role;
    message.innerHTML = parseMarkdown(rawText || '');

    var inlineMedia = buildInlineMedia(attachments || []);
    if (inlineMedia) {
      message.appendChild(inlineMedia);
    }

    wrapper.appendChild(meta);
    wrapper.appendChild(message);
    chatEl.appendChild(wrapper);
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function appendLoading() {
    var wrapper = document.createElement('div');
    wrapper.className = 'msg-wrapper';

    var meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.innerHTML = '<span class="meta-tag">PG1</span><span>•</span><span>Thinking</span>';

    var message = document.createElement('div');
    message.className = 'message assistant';
    message.innerHTML = '<div class="loading-dots"><span></span><span></span><span></span></div>';

    wrapper.appendChild(meta);
    wrapper.appendChild(message);
    chatEl.appendChild(wrapper);
    chatEl.scrollTop = chatEl.scrollHeight;
    return wrapper;
  }

  function clearPendingAttachments() {
    state.pendingAttachments.forEach(revokeAttachmentUrl);
    state.pendingAttachments = [];
    if (imageInput) imageInput.value = '';
    if (videoInput) videoInput.value = '';
    renderAttachments();
  }

  async function sendMessage() {
    var typedPrompt = inputEl.value.trim();
    if (!typedPrompt && !state.pendingAttachments.length) return;

    var outgoingAttachments = state.pendingAttachments.map(function (attachment) {
      return {
        kind: attachment.kind,
        name: attachment.name,
        type: attachment.type,
        size: attachment.size,
        previewUrl: attachment.previewUrl
      };
    });
    var fallbackPrompt = typedPrompt || 'Please review the attached media context.';
    var attachmentSummary = buildAttachmentSummary();
    var prompt = attachmentSummary ? fallbackPrompt + '\n\nAttached context:\n' + attachmentSummary : fallbackPrompt;
    var chatApiUrl = window.PG1_CHAT_API_URL;

    appendMessage('user', fallbackPrompt, outgoingAttachments, attachmentSummary ? 'Media attached' : 'Prompt queued');
    inputEl.value = '';
    autoResizeTextarea();
    sendBtn.disabled = true;
    setStatus('Sending through secure backend…', 'Sending');

    var loadingMessage = appendLoading();

    try {
      if (!chatApiUrl) {
        throw new Error('PG1 chat API URL is not configured');
      }

      var res = await fetch(chatApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt,
          message: prompt,
          userMessage: prompt,
          attachments: cloneAttachmentPayload()
        })
      });

      var responseText = await res.text();
      var data = null;

      if (responseText) {
        try {
          data = JSON.parse(responseText);
        } catch (parseError) {
          if (!res.ok) {
            throw new Error('Backend returned HTTP ' + res.status);
          }
          throw new Error('Invalid JSON response from PG1 backend');
        }
      }

      loadingMessage.remove();

      if (!res.ok) {
        throw new Error((data && (data.error || data.reply || data.message)) || ('Backend returned HTTP ' + res.status));
      }

      var reply = (data && (data.reply || data.response || data.message || data.text)) || 'No response payload received.';
      state.lastAssistantReply = reply;
      appendMessage('assistant', reply, null, 'Response ready');
      clearPendingAttachments();
      setStatus('Ready', 'Ready');
      if (state.ttsEnabled) {
        speak(reply, false);
      }
    } catch (error) {
      loadingMessage.remove();
      var errorMessage = error && error.message ? error.message : 'Unknown error';
      var backendMessage = errorMessage.indexOf('HTTP') !== -1 || errorMessage.indexOf('Invalid JSON') !== -1
        ? '**Error:** PG1 backend returned an unexpected server response.\n- Check the deployed backend logs\n- Verify the backend origin configuration'
        : '**Error:** Unable to reach the configured PG1 backend.\n- Verify the backend origin is correct\n- Check network and server logs';
      appendMessage('assistant', backendMessage, null, 'Connection issue');
      setStatus('Connection failed: ' + errorMessage, 'Offline');
    } finally {
      sendBtn.disabled = false;
      inputEl.focus();
    }
  }

  function initRecognition() {
    if (!micBtn) return;

    if (!SpeechRecognition) {
      micBtn.disabled = true;
      micBtn.classList.add('is-muted');
      micBtn.title = 'Microphone input is not supported in this browser';
      setStatus(state.ttsEnabled ? 'Voice on • mic unavailable in this browser' : 'Mic unavailable in this browser', 'Mic unavailable');
      return;
    }

    state.recognition = new SpeechRecognition();
    state.recognition.lang = 'en-US';
    state.recognition.interimResults = true;
    state.recognition.continuous = false;

    var finalTranscript = '';

    state.recognition.onstart = function () {
      finalTranscript = '';
      setListeningState(true);
    };

    state.recognition.onresult = function (event) {
      var interim = '';
      for (var i = event.resultIndex; i < event.results.length; i += 1) {
        var transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript + ' ';
        } else {
          interim += transcript;
        }
      }

      var merged = (finalTranscript + interim).trim();
      if (merged) {
        inputEl.value = merged;
        autoResizeTextarea();
      }
    };

    state.recognition.onerror = function (event) {
      setListeningState(false);
      setStatus('Microphone error: ' + event.error, 'Mic error');
    };

    state.recognition.onend = function () {
      setListeningState(false);
    };
  }

  inputEl.addEventListener('input', autoResizeTextarea);
  inputEl.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });
  sendBtn.addEventListener('click', sendMessage);

  quickButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      inputEl.value = button.getAttribute('data-quick-prompt') || '';
      autoResizeTextarea();
      sendMessage();
    });
  });

  if (imageBtn && imageInput) {
    imageBtn.addEventListener('click', function () {
      imageInput.click();
    });
    imageInput.addEventListener('change', function (event) {
      addAttachment(event.target.files && event.target.files[0], 'Image');
    });
  }

  if (videoBtn && videoInput) {
    videoBtn.addEventListener('click', function () {
      videoInput.click();
    });
    videoInput.addEventListener('change', function (event) {
      addAttachment(event.target.files && event.target.files[0], 'Video');
    });
  }

  if (voiceBtn) {
    voiceBtn.addEventListener('click', function () {
      if (!('speechSynthesis' in window)) {
        setStatus('Voice playback is not supported in this browser.', 'Voice unavailable');
        return;
      }

      if (state.speaking) {
        stopSpeech();
        setStatus('Voice playback stopped.', 'Voice off');
        return;
      }

      state.ttsEnabled = !state.ttsEnabled;
      updateVoiceButton();
      if (state.ttsEnabled && state.lastAssistantReply) {
        speak(state.lastAssistantReply, true);
      } else {
        setStatus(state.ttsEnabled ? 'Voice playback enabled.' : 'Voice playback muted.', state.ttsEnabled ? 'Voice on' : 'Voice off');
      }
    });
  }

  if (micBtn) {
    micBtn.addEventListener('click', function () {
      if (!state.recognition) return;
      if (state.listening) {
        state.recognition.stop();
      } else {
        stopSpeech();
        state.recognition.start();
      }
    });
  }

  if (enginePill && modalOverlay) {
    enginePill.addEventListener('click', function () {
      modalOverlay.classList.add('active');
    });
  }

  if (modalClose && modalOverlay) {
    modalClose.addEventListener('click', function () {
      modalOverlay.classList.remove('active');
    });
    modalOverlay.addEventListener('click', function (event) {
      if (event.target === modalOverlay) {
        modalOverlay.classList.remove('active');
      }
    });
  }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && modalOverlay) {
      modalOverlay.classList.remove('active');
    }
  });

  window.addEventListener('beforeunload', function () {
    stopSpeech();
    clearPendingAttachments();
  });

  updateVoiceButton();
  initRecognition();
  autoResizeTextarea();
  renderAttachments();
  setStatus(state.ttsEnabled ? 'Voice on • secure channel ready' : 'Secure channel ready', 'Ready');
})();
