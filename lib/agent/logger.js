export class ExecutionLogger {
  constructor(store) {
    this.store = store;
  }

  async log({ taskId, sessionId, state, thought, action, observation, metadata = {}, level = 'info' }) {
    const entry = {
      task_id: taskId,
      session_id: sessionId,
      state,
      level,
      thought,
      action,
      observation,
      metadata
    };

    await this.store.insert('agent_execution_logs', entry);
    return entry;
  }

  async list({ taskId, sessionId, limit = 200 }) {
    const filters = {};
    if (taskId) filters.task_id = taskId;
    if (sessionId) filters.session_id = sessionId;
    return this.store.select('agent_execution_logs', { filters, limit, orderBy: 'created_at', ascending: false });
  }
}
