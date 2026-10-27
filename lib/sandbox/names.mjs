// PG1 Sandbox: every thing in a world has a name.
//
// Things a template or an agent named keep their names. The inhabitants of
// a life rule are named by society.mjs, in their own culture's way, so they
// are left to it. Everything else without a name gets one here, the same
// way every time (the engine stays deterministic):
//   - a thing with an owner who has a name: "Ivie Aigbe's car";
//   - anything else: its kind and a number, "Car 12", "Space station 1",
//     never a number another thing of its kind already has.
//
//   nameEntities(entities, { skipKinds }) -> how many were named (in place)

const MAX = 80;

export function kindLabel(kind) {
  const s = String(kind || 'thing').replace(/[_-]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : 'Thing';
}

const named = (e) => typeof (e.properties && e.properties.name) === 'string' && e.properties.name.trim() !== '';

function personName(o) {
  const p = o.properties;
  return typeof p.family === 'string' && p.family && !p.name.includes(p.family) ? `${p.name} ${p.family}` : p.name;
}

export function nameEntities(ents, { skipKinds = [] } = {}) {
  const skip = new Set(skipKinds);
  const todo = ents.filter((e) => e && e.properties && !named(e) && !skip.has(e.kind));
  if (!todo.length) return 0;
  const byId = new Map(ents.map((e) => [e.id, e]));
  const taken = new Set(ents.filter(named).map((e) => e.properties.name));
  // Each kind's things in id order: a thing's number is its place among them.
  const order = new Map();
  for (const e of ents.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const list = order.get(e.kind) || []; list.push(e.id); order.set(e.kind, list);
  }
  const free = (base) => { if (!taken.has(base)) return base; let n = 2; while (taken.has(`${base} ${n}`)) n++; return `${base} ${n}`; };
  for (const e of todo.sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const label = kindLabel(e.kind);
    const owner = typeof e.properties.owner === 'string' ? byId.get(e.properties.owner) : null;
    let name;
    if (owner && named(owner)) name = free(`${personName(owner)}'s ${label.toLowerCase()}`.slice(0, MAX));
    else {
      let n = order.get(e.kind).indexOf(e.id) + 1;
      while (taken.has(`${label} ${n}`)) n++;
      name = `${label} ${n}`.slice(0, MAX);
    }
    e.properties.name = name;
    taken.add(name);
  }
  return todo.length;
}
