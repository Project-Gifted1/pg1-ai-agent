// A world's rules in plain words, for the viewer and the chat. Built only
// from the validated rule fields (lib/sandbox/engine.mjs), never from free
// text. Worlds are simulations: every human-facing summary says so.

export const SIMULATION_LABEL = 'Simulation';
export const BLIND_LABEL = 'SIMULATION — blind experiment';

// fox -> foxes, berry -> berries, grass stays grass, person -> people.
const IRREGULAR = { person: 'people', child: 'children', bus: 'buses', deer: 'deer', fish: 'fish', sheep: 'sheep', mouse: 'mice', grass: 'grass', crop: 'crops' };
const plural = (k) => {
  const w = String(k).replace(/[_-]+/g, ' ');
  const last = w.split(' ').pop();
  if (IRREGULAR[last]) return w.slice(0, w.length - last.length) + IRREGULAR[last];
  if (/(?:s|x|z|ch|sh)$/.test(w)) return w.endsWith('s') ? w : `${w}es`;
  if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies`;
  return `${w}s`;
};
const n = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));
const every = (k) => (k === 1 ? 'every step' : `every ${k} steps`);

export function ruleInWords(r) {
  switch (r && r.type) {
    case 'move':
      return r.wander !== undefined
        ? `${plural(r.kind)} wander up to ${n(r.wander)} m a step`
        : `${plural(r.kind)} move by (${n(r.velocity.x)}, ${n(r.velocity.y)}, ${n(r.velocity.z)}) m a step`;
    case 'spawn':
      return `${every(r.every)}, ${r.chance >= 1 ? 'a new' : `with a ${Math.round(r.chance * 100)}% chance, a new`} ${r.kind} appears${r.near ? ` near a ${r.near}` : ''}`;
    case 'decay':
      return `${plural(r.kind)} lose ${n(r.amount)} ${r.property} a step${r.remove_below !== undefined ? ` and disappear below ${n(r.remove_below)}` : ''}`;
    case 'grow':
      return `${plural(r.kind)} gain ${n(r.amount)} ${r.property} a step${r.max !== undefined ? `, up to ${n(r.max)}` : ''}`;
    case 'interact': {
      const parts = [];
      if (r.effect) parts.push(`the ${r.effect.on === 'a' ? r.a : r.b}'s ${r.effect.property} changes by ${n(r.effect.delta)}`);
      if (r.remove) parts.push(`the ${r.remove === 'a' ? r.a : r.b} is removed`);
      if (r.emit) parts.push(`"${r.emit}" is recorded`);
      return `when a ${r.a} comes within ${n(r.radius)} m of a ${r.b}, ${parts.join(' and ')}`;
    }
    case 'emit':
      return `${every(r.every)}, each ${r.kind} records "${r.event}"`;
    case 'attract':
      return `${plural(r.kind)} move up to ${n(r.strength)} m a step toward the nearest ${r.toward} within ${n(r.radius)} m`;
    case 'repel':
      return `${plural(r.kind)} move up to ${n(r.strength)} m a step away from the nearest ${r.from} within ${n(r.radius)} m`;
    case 'condition': {
      const parts = [];
      if (r.then) parts.push(r.then.delta !== undefined ? `its ${r.then.property} changes by ${n(r.then.delta)}` : `its ${r.then.property} becomes ${JSON.stringify(r.then.set)}`);
      if (r.emit) parts.push(`"${r.emit}" is recorded`);
      if (r.remove) parts.push('it is removed');
      return `when a ${r.kind}'s ${r.if.property} ${r.if.op} ${JSON.stringify(r.if.value)}, ${parts.join(' and ')}`;
    }
    case 'travel': {
      const pace = r.speed !== undefined ? `at up to ${n(r.speed)} m a step` : 'at their own speed';
      const next = r.roam && r.roam.length ? `, then pick a ${r.roam.map((k) => String(k).replace(/[_-]+/g, ' ')).join(', ')} to go to next` : '';
      return `${plural(r.kind)} head for their target ${pace}${next}`;
    }
    case 'orbit':
      return `${plural(r.kind)} circle ${r.around ? `the nearest ${String(r.around).replace(/[_-]+/g, ' ')} or ` : ''}what they orbit`;
    default:
      return 'an unknown rule';
  }
}

export function rulesInWords(spec) {
  return (spec && Array.isArray(spec.rules) ? spec.rules : []).map((r) => ({ id: r.id, type: r.type, text: ruleInWords(r) }));
}
