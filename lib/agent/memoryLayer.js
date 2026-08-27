export class MemoryLayer {
  constructor(store) {
    this.store = store;
  }

  async addConversationMessage({ sessionId, role, content, metadata = {} }) {
    const row = {
      session_id: sessionId,
      role,
      content,
      metadata
    };
    await this.store.insert('agent_conversations', row);
    return row;
  }

  async getConversationContext({ sessionId, limit = 30 }) {
    return this.store.select('agent_conversations', {
      filters: { session_id: sessionId },
      limit,
      orderBy: 'created_at',
      ascending: false
    });
  }

  async compressConversation({ sessionId, keepRecent = 12 }) {
    const rows = await this.getConversationContext({ sessionId, limit: 200 });
    if (rows.length <= keepRecent) {
      return { compressed: false, summary: null, kept: rows.length };
    }

    const recent = rows.slice(0, keepRecent);
    const archived = rows.slice(keepRecent);
    const summary = archived
      .map((row) => `${row.role}: ${String(row.content || '').slice(0, 160)}`)
      .reverse()
      .join('\n');

    await this.store.insert('agent_memory', {
      session_id: sessionId,
      memory_type: 'conversation_summary',
      content: summary,
      metadata: {
        compressed_count: archived.length,
        compressed_at: new Date().toISOString()
      }
    });

    return {
      compressed: true,
      summary,
      kept: recent.length,
      archived: archived.length
    };
  }

  async addLongTermMemory({ taskId, sessionId, memoryType, content, metadata = {}, embedding = null }) {
    return this.store.insert('agent_memory', {
      task_id: taskId,
      session_id: sessionId,
      memory_type: memoryType,
      content,
      metadata,
      embedding
    });
  }

  async queryLongTermMemory({ sessionId, query = '', limit = 20 }) {
    const rows = await this.store.select('agent_memory', { filters: sessionId ? { session_id: sessionId } : {}, limit: 300 });
    const needle = String(query || '').toLowerCase();

    if (!needle) return rows.slice(0, limit);

    const scored = rows
      .map((row) => {
        const hay = `${row.memory_type || ''} ${row.content || ''} ${JSON.stringify(row.metadata || {})}`.toLowerCase();
        const score = keywordScore(needle, hay);
        return { row, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.row);

    return scored;
  }
}

function keywordScore(query, text) {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .reduce((sum, token) => (text.includes(token) ? sum + 1 : sum), 0);
}
