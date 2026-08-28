/**
 * pg1-threads.js
 * IndexedDB-backed thread/message persistence for PG1 Sovereign Agent™.
 *
 * Design goals:
 *  - Fully isolated data layer (no UI coupling).
 *  - Safe against QuotaExceededError and unavailable storage.
 *  - Media stored as URL references, not raw binaries.
 *  - Max 200 threads × 500 messages each, with oldest auto-pruning.
 */
(function (root) {
  'use strict';

  var DB_NAME = 'pg1-agent-db';
  var DB_VERSION = 1;
  var MAX_THREADS = 200;
  var MAX_MESSAGES_PER_THREAD = 500;

  var db = null;
  var dbReady = false;
  var dbFailed = false;

  // ── Open / migrate DB ────────────────────────────────────────────────────────

  function openDB() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('IndexedDB not available')); return; }

      var req = window.indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = function (e) {
        var d = e.target.result;

        if (!d.objectStoreNames.contains('threads')) {
          var ts = d.createObjectStore('threads', { keyPath: 'id' });
          ts.createIndex('updatedAt', 'updatedAt', { unique: false });
        }

        if (!d.objectStoreNames.contains('messages')) {
          var ms = d.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
          ms.createIndex('threadId', 'threadId', { unique: false });
          ms.createIndex('createdAt', 'createdAt', { unique: false });
        }

        if (!d.objectStoreNames.contains('attachments')) {
          var as = d.createObjectStore('attachments', { keyPath: 'id', autoIncrement: true });
          as.createIndex('messageId', 'messageId', { unique: false });
          as.createIndex('threadId', 'threadId', { unique: false });
        }
      };

      req.onsuccess = function (e) { db = e.target.result; dbReady = true; resolve(db); };
      req.onerror = function (e) { dbFailed = true; reject(e.target.error); };
    });
  }

  function ensureDB() {
    if (dbReady) return Promise.resolve(db);
    if (dbFailed) return Promise.reject(new Error('IndexedDB unavailable'));
    return openDB();
  }

  // ── Quota-safe wrapper ───────────────────────────────────────────────────────

  function safeWrite(fn) {
    return fn().catch(function (err) {
      if (err && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED')) {
        console.warn('[PG1 Threads] Storage quota exceeded – clean up old threads.');
        dispatchStorageWarning('quota_exceeded');
      }
      throw err;
    });
  }

  function dispatchStorageWarning(reason) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('pg1:storage-warning', { detail: { reason: reason } }));
    }
  }

  // ── ID helpers ────────────────────────────────────────────────────────────────

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ── Thread CRUD ───────────────────────────────────────────────────────────────

  function createThread(title) {
    return safeWrite(function () {
      return ensureDB().then(function (d) {
        return new Promise(function (resolve, reject) {
          var thread = {
            id: newId(),
            title: title || 'New Chat',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            mode: 'default',
            messageCount: 0
          };
          var tx = d.transaction('threads', 'readwrite');
          var req = tx.objectStore('threads').put(thread);
          req.onsuccess = function () { resolve(thread); };
          req.onerror = function (e) { reject(e.target.error); };
        }).then(function (thread) {
          return pruneThreadsIfNeeded().then(function () { return thread; });
        });
      });
    });
  }

  function getThread(id) {
    return ensureDB().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction('threads', 'readonly');
        var req = tx.objectStore('threads').get(id);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function (e) { reject(e.target.error); };
      });
    });
  }

  function listThreads() {
    return ensureDB().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction('threads', 'readonly');
        var req = tx.objectStore('threads').index('updatedAt').getAll();
        req.onsuccess = function () { resolve((req.result || []).reverse()); };
        req.onerror = function (e) { reject(e.target.error); };
      });
    });
  }

  function updateThread(id, patch) {
    return safeWrite(function () {
      return ensureDB().then(function (d) {
        return new Promise(function (resolve, reject) {
          var tx = d.transaction('threads', 'readwrite');
          var store = tx.objectStore('threads');
          var req = store.get(id);
          req.onsuccess = function () {
            var base = req.result || {};
            var resolved = (typeof patch === 'function') ? patch(base) : patch;
            var thread = Object.assign({}, base, resolved, { updatedAt: Date.now() });
            var putReq = store.put(thread);
            putReq.onsuccess = function () { resolve(thread); };
            putReq.onerror = function (e) { reject(e.target.error); };
          };
          req.onerror = function (e) { reject(e.target.error); };
        });
      });
    });
  }

  function deleteThread(id) {
    return ensureDB().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(['threads', 'messages', 'attachments'], 'readwrite');
        tx.objectStore('threads').delete(id);
        var msgIdx = tx.objectStore('messages').index('threadId');
        var attIdx = tx.objectStore('attachments').index('threadId');

        var delReq = msgIdx.openCursor(IDBKeyRange.only(id));
        delReq.onsuccess = function (e) {
          var cur = e.target.result;
          if (cur) { cur.delete(); cur.continue(); }
        };
        var attReq = attIdx.openCursor(IDBKeyRange.only(id));
        attReq.onsuccess = function (e) {
          var cur = e.target.result;
          if (cur) { cur.delete(); cur.continue(); }
        };
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function (e) { reject(e.target.error); };
      });
    });
  }

  function pruneThreadsIfNeeded() {
    return listThreads().then(function (threads) {
      if (threads.length <= MAX_THREADS) return;
      var toDelete = threads.slice(MAX_THREADS);
      return Promise.all(toDelete.map(function (t) { return deleteThread(t.id); }));
    }).catch(function () {});
  }

  // ── Message CRUD ──────────────────────────────────────────────────────────────

  function addMessage(threadId, role, content, meta) {
    return safeWrite(function () {
      return ensureDB().then(function (d) {
        return new Promise(function (resolve, reject) {
          var msg = {
            threadId: threadId,
            role: role,            // 'user' | 'assistant'
            content: content,
            meta: meta || {},      // { attachments: [], mode: '', model: '' }
            createdAt: Date.now(),
            edited: false
          };
          var tx = d.transaction('messages', 'readwrite');
          var req = tx.objectStore('messages').add(msg);
          req.onsuccess = function () { msg.id = req.result; resolve(msg); };
          req.onerror = function (e) { reject(e.target.error); };
        }).then(function (msg) {
          return Promise.all([
            updateThread(threadId, function (t) { return { messageCount: ((t && t.messageCount) || 0) + 1 }; }),
            pruneMessagesIfNeeded(threadId)
          ]).then(function () { return msg; });
        });
      });
    });
  }

  function getMessages(threadId) {
    return ensureDB().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction('messages', 'readonly');
        var req = tx.objectStore('messages').index('threadId').getAll(IDBKeyRange.only(threadId));
        req.onsuccess = function () {
          var msgs = (req.result || []).sort(function (a, b) { return a.createdAt - b.createdAt; });
          resolve(msgs);
        };
        req.onerror = function (e) { reject(e.target.error); };
      });
    });
  }

  function editMessage(messageId, newContent) {
    return safeWrite(function () {
      return ensureDB().then(function (d) {
        return new Promise(function (resolve, reject) {
          var tx = d.transaction('messages', 'readwrite');
          var store = tx.objectStore('messages');
          var req = store.get(messageId);
          req.onsuccess = function () {
            var msg = Object.assign({}, req.result, { content: newContent, edited: true, editedAt: Date.now() });
            var putReq = store.put(msg);
            putReq.onsuccess = function () { resolve(msg); };
            putReq.onerror = function (e) { reject(e.target.error); };
          };
          req.onerror = function (e) { reject(e.target.error); };
        });
      });
    });
  }

  function deleteMessage(messageId) {
    return ensureDB().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction('messages', 'readwrite');
        var req = tx.objectStore('messages').delete(messageId);
        req.onsuccess = function () { resolve(); };
        req.onerror = function (e) { reject(e.target.error); };
      });
    });
  }

  function pruneMessagesIfNeeded(threadId) {
    return getMessages(threadId).then(function (msgs) {
      if (msgs.length <= MAX_MESSAGES_PER_THREAD) return;
      var toDelete = msgs.slice(0, msgs.length - MAX_MESSAGES_PER_THREAD);
      return Promise.all(toDelete.map(function (m) { return deleteMessage(m.id); }));
    }).catch(function () {});
  }

  // ── Attachment references ─────────────────────────────────────────────────────

  function addAttachment(threadId, messageId, ref) {
    // ref: { name, url, type, size, source: 'upload'|'generated' }
    return safeWrite(function () {
      return ensureDB().then(function (d) {
        return new Promise(function (resolve, reject) {
          var att = Object.assign({ threadId: threadId, messageId: messageId, createdAt: Date.now() }, ref);
          var tx = d.transaction('attachments', 'readwrite');
          var req = tx.objectStore('attachments').add(att);
          req.onsuccess = function () { att.id = req.result; resolve(att); };
          req.onerror = function (e) { reject(e.target.error); };
        });
      });
    });
  }

  function getAttachments(threadId) {
    return ensureDB().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction('attachments', 'readonly');
        var req = tx.objectStore('attachments').index('threadId').getAll(IDBKeyRange.only(threadId));
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function (e) { reject(e.target.error); };
      });
    });
  }

  // ── Storage health ────────────────────────────────────────────────────────────

  function getStorageEstimate() {
    if (navigator.storage && navigator.storage.estimate) {
      return navigator.storage.estimate();
    }
    return Promise.resolve({ usage: 0, quota: 0 });
  }

  // ── Export helpers ────────────────────────────────────────────────────────────

  function exportThreadAsText(threadId) {
    return Promise.all([getThread(threadId), getMessages(threadId)]).then(function (results) {
      var thread = results[0];
      var msgs = results[1];
      var lines = ['# ' + (thread ? thread.title : 'Chat') + '\n'];
      msgs.forEach(function (m) {
        var ts = new Date(m.createdAt).toLocaleString();
        lines.push('[' + ts + '] ' + (m.role === 'user' ? 'You' : 'PG1') + ':\n' + m.content + '\n');
      });
      return lines.join('\n');
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  var PG1Threads = {
    init: function () { return openDB().catch(function (err) { console.warn('[PG1 Threads] DB unavailable:', err.message); }); },
    createThread: createThread,
    getThread: getThread,
    listThreads: listThreads,
    updateThread: updateThread,
    deleteThread: deleteThread,
    addMessage: addMessage,
    getMessages: getMessages,
    editMessage: editMessage,
    deleteMessage: deleteMessage,
    addAttachment: addAttachment,
    getAttachments: getAttachments,
    getStorageEstimate: getStorageEstimate,
    exportThreadAsText: exportThreadAsText
  };

  root.PG1Threads = PG1Threads;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
