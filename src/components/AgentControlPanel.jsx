import React, { useEffect, useMemo, useState } from 'react';

export default function AgentControlPanel({ sessionId = 'default-session' }) {
  const [taskText, setTaskText] = useState('');
  const [taskId, setTaskId] = useState('');
  const [status, setStatus] = useState(null);
  const [logs, setLogs] = useState([]);
  const [costs, setCosts] = useState({ total_cost_cents: 0, count: 0 });
  const [memory, setMemory] = useState([]);

  const progress = useMemo(() => {
    const p = status?.task?.progress;
    if (!p || !p.total_steps) return 0;
    return Math.round((p.completed_steps / p.total_steps) * 100);
  }, [status]);

  async function createPlan() {
    const res = await fetch('/api/agent/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, task: taskText })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Plan request failed');
    setTaskId(data.taskId);
  }

  async function executeStep() {
    if (!taskId) return;
    await fetch('/api/agent/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, taskId })
    });
  }

  useEffect(() => {
    if (!taskId) return;
    const tick = async () => {
      const [statusRes, logsRes, costsRes, memoryRes] = await Promise.all([
        fetch(`/api/agent/status?sessionId=${encodeURIComponent(sessionId)}&taskId=${encodeURIComponent(taskId)}`),
        fetch(`/api/agent/logs?sessionId=${encodeURIComponent(sessionId)}&taskId=${encodeURIComponent(taskId)}`),
        fetch(`/api/agent/costs?sessionId=${encodeURIComponent(sessionId)}&taskId=${encodeURIComponent(taskId)}`),
        fetch(`/api/agent/memory?sessionId=${encodeURIComponent(sessionId)}&limit=8`)
      ]);

      if (statusRes.ok) setStatus(await statusRes.json());
      if (logsRes.ok) setLogs((await logsRes.json()).logs || []);
      if (costsRes.ok) setCosts(await costsRes.json());
      if (memoryRes.ok) setMemory((await memoryRes.json()).memories || []);
    };

    tick();
    const interval = setInterval(tick, 2500);
    return () => clearInterval(interval);
  }, [sessionId, taskId]);

  return (
    <section>
      <h2>Agent Control Panel</h2>
      <div>
        <textarea value={taskText} onChange={(e) => setTaskText(e.target.value)} placeholder="Describe a multi-step task" />
        <button onClick={createPlan}>Plan Task</button>
        <button onClick={executeStep} disabled={!taskId}>Execute Next Step</button>
      </div>
      <p>Task ID: {taskId || '-'}</p>
      <p>Progress: {progress}%</p>
      <p>Cost: {Number(costs.total_cost_cents || 0).toFixed(4)} cents</p>
      <h3>Execution Logs</h3>
      <ul>{logs.slice(0, 8).map((log) => <li key={log.id}>{log.state}: {log.action} → {log.observation}</li>)}</ul>
      <h3>Memory</h3>
      <ul>{memory.slice(0, 6).map((item) => <li key={item.id}>{item.memory_type}: {item.content}</li>)}</ul>
    </section>
  );
}
