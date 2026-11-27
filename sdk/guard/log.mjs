// pg1-guard action log: one entry per step (proposed, decided, approved or
// declined, ran, failed), secrets withheld, kept in memory and, if a sink
// is given, written out as it happens (a JSONL file, a database, a queue).
//
//   const log = createLog({ sink: jsonlSink('./agent-actions.jsonl') });
//   log.entries()           // everything so far, oldest first
//   log.replay(actionId)    // the steps of one action, in order

import { appendFileSync } from 'node:fs';
import { redact } from './policy.mjs';

export function createLog({ sink = null, max = 5000, clock = () => Date.now() } = {}) {
  const items = [];
  return {
    write(step, action, extra = {}) {
      const entry = {
        at: new Date(clock()).toISOString(),
        step,
        action_id: action && action.id,
        tool: action && action.tool,
        args: redact(action && action.args),
        ...redact(extra)
      };
      items.push(entry);
      if (items.length > max) items.splice(0, items.length - max);
      if (sink) {
        try { sink(entry); } catch { /* a failing sink never stops the agent; the entry stays in memory */ }
      }
      return entry;
    },
    entries: () => items.slice(),
    replay: (actionId) => items.filter((e) => e.action_id === actionId)
  };
}

export function jsonlSink(path) {
  return (entry) => appendFileSync(path, JSON.stringify(entry) + '\n');
}
