// What changed in a world over a step, for the viewer's Play (api/sandbox.mjs
// op step with `since`): instead of every entity and the whole road network
// on every step, only the entities that changed (added or different in any
// way) and the ids of those that went. The viewer merges them into the world
// it already has (public/index.html mergeSandboxChanges). Pure.
//
//   entitySnapshot(entities)          id -> its JSON, before the step
//   worldChanges(snapshot, entities)  { upserts: [entity], removed: [id] }

export function entitySnapshot(entities) {
  const m = new Map();
  for (const e of entities || []) m.set(e.id, JSON.stringify(e));
  return m;
}

export function worldChanges(snapshot, entities) {
  const upserts = [];
  const seen = new Set();
  for (const e of entities || []) {
    seen.add(e.id);
    if (snapshot.get(e.id) !== JSON.stringify(e)) upserts.push(e);
  }
  const removed = [];
  for (const id of snapshot.keys()) if (!seen.has(id)) removed.push(id);
  return { upserts, removed };
}
