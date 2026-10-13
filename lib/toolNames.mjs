// "Did you mean ...?" for a tools/call (or A2A skill) naming a tool this
// server does not have. Clients often send a near miss: a namespaced name
// ("pg1-threat-intel:check_domain_age", "pg1.check_domain_age"), dashes or
// spaces for underscores, other casing, a truncated name ("get_cve") or a
// typo. The suggestion is always one of `names` (never the caller's text,
// which an error message must not echo back), or null when nothing is
// close enough to be a useful guess.

const MAX_EDIT_DISTANCE = 3;

export function normalizeToolName(value) {
  const text = String(value ?? '').trim().toLowerCase();
  const last = text.split(/[:/.]/).filter(Boolean).pop() || '';
  return last.replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
}

function editDistance(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

export function suggestToolName(requested, names) {
  const wanted = normalizeToolName(requested);
  if (!wanted || wanted.length > 80) return null;
  const exact = names.find((n) => n === wanted);
  if (exact) return exact;
  // A truncated or extended name: only when it points at exactly one tool.
  const partial = names.filter((n) => wanted.length >= 4 && (n.startsWith(wanted) || wanted.startsWith(n)));
  if (partial.length === 1) return partial[0];
  let best = null;
  let bestDistance = MAX_EDIT_DISTANCE + 1;
  for (const n of names) {
    const d = editDistance(wanted, n);
    if (d < bestDistance) { best = n; bestDistance = d; }
  }
  return bestDistance <= MAX_EDIT_DISTANCE ? best : null;
}
