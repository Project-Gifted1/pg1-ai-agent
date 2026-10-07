// GITHUB WRITE GUARD: the one place that decides where PG1 may write on
// GitHub. Every write in api/chat.mjs (APPLY_SURGICAL_PATCH,
// ACCEPT_AUTHORIZATION, REORGANIZE_FILES and the /approve step that commits
// a stored proposal) goes through it:
// - the repository must be on WRITE_ALLOWLIST (owner is fixed, never taken
//   from the request or from an env var);
// - every path must be a plain relative path inside that repository's
//   allowed directories or files (no dot-segments, no dotfiles, so never
//   .github/, .env or .git; never vercel.json or package files);
// - the branch written to is always a fresh agent branch, never main or any
//   other protected name. Changes reach main only through the pull request.

export const WRITE_OWNER = 'Project-Gifted1';

// Per repository: directories (prefix match) and single files that may be
// written. Anything else is refused.
export const WRITE_ALLOWLIST = Object.freeze({
  'pg1-ai-agent': Object.freeze({
    dirs: ['api/', 'lib/', 'public/', 'components/', 'app/', 'src/', 'workers/', 'styles/', 'docs/', 'tests/', 'supabase/migrations/'],
    files: ['README.md', 'README_DEPLOYMENT.md', 'MEMORY.md', 'style.css', 'index.js'],
    rootExtensions: []
  }),
  'sovereign-threat-pipeline': Object.freeze({
    dirs: ['api/', 'lib/', 'scripts/', 'tests/', 'docs/', 'migrations/'],
    files: ['README.md'],
    rootExtensions: ['.py']
  })
});

// Branch names a write may never target, whatever the request says.
const PROTECTED_BRANCHES = new Set(['main', 'master', 'production', 'prod', 'gh-pages', 'head']);

// Prefixes of the branches PG1 creates; a write to any other name is refused.
export const AGENT_BRANCH_PREFIXES = ['surgical-patch-', 'agent-patch-', 'reorganize-', 'approved-'];

const MAX_PATH_LENGTH = 256;

// targetRepo is a bare name ("pg1-ai-agent") or "owner/name". Returns the
// canonical "Project-Gifted1/<name>" when allowed, otherwise null.
export function resolveWriteRepo(targetRepo) {
  if (typeof targetRepo !== 'string') return null;
  var raw = targetRepo.trim();
  if (!raw) return null;
  var parts = raw.split('/');
  if (parts.length > 2) return null;
  var owner = parts.length === 2 ? parts[0] : WRITE_OWNER;
  var name = parts.length === 2 ? parts[1] : parts[0];
  if (owner.toLowerCase() !== WRITE_OWNER.toLowerCase()) return null;
  var canonical = Object.keys(WRITE_ALLOWLIST).find(function (r) { return r.toLowerCase() === name.toLowerCase(); });
  return canonical ? `${WRITE_OWNER}/${canonical}` : null;
}

// repoPath is the canonical "owner/name" from resolveWriteRepo (or a stored
// proposal's repoPath, which is re-checked here). Returns { ok, reason }.
export function checkWritePath(repoPath, path) {
  var repo = resolveWriteRepo(repoPath);
  if (!repo) return { ok: false, reason: 'repository is not on the write allow-list' };
  if (typeof path !== 'string' || !path) return { ok: false, reason: 'path is missing' };
  if (path.length > MAX_PATH_LENGTH) return { ok: false, reason: 'path is too long' };
  if (/[\\\u0000-\u001f\u007f]/.test(path)) return { ok: false, reason: 'path has a backslash or control character' };
  if (path.startsWith('/')) return { ok: false, reason: 'path must be relative' };
  var segments = path.split('/');
  for (var i = 0; i < segments.length; i++) {
    var seg = segments[i];
    if (!seg) return { ok: false, reason: 'path has an empty segment' };
    if (seg.startsWith('.')) return { ok: false, reason: 'path has a dot-segment or dotfile' };
  }
  var rules = WRITE_ALLOWLIST[repo.split('/')[1]];
  var inDir = rules.dirs.some(function (d) { return path.startsWith(d); });
  var isFile = rules.files.indexOf(path) !== -1;
  var isRootExt = segments.length === 1 && rules.rootExtensions.some(function (ext) { return path.endsWith(ext); });
  if (!inDir && !isFile && !isRootExt) return { ok: false, reason: 'path is outside the allowed directories for this repository' };
  return { ok: true };
}

// Checks every path; returns the first failure as { ok: false, path, reason }.
export function checkWritePaths(repoPath, paths) {
  for (var i = 0; i < paths.length; i++) {
    var check = checkWritePath(repoPath, paths[i]);
    if (!check.ok) return { ok: false, path: paths[i], reason: check.reason };
  }
  return { ok: true };
}

export function isAgentBranch(branch) {
  if (typeof branch !== 'string' || !branch) return false;
  if (PROTECTED_BRANCHES.has(branch.toLowerCase())) return false;
  return AGENT_BRANCH_PREFIXES.some(function (p) { return branch.startsWith(p) && branch.length > p.length; });
}

// A fresh branch name for one write. Throws for an unknown prefix so a typo
// can never fall back to main.
export function agentBranchName(prefix) {
  if (AGENT_BRANCH_PREFIXES.indexOf(prefix) === -1) throw new Error(`unknown agent branch prefix '${prefix}'`);
  return `${prefix}${Date.now()}`;
}

// Creates refs/heads/<branch> at sha. Resolves to { ok, status }. A write
// must not go ahead unless this succeeded: the contents API writes to the
// default branch when "branch" is missing, so the branch has to exist and be
// an agent branch first.
export async function createAgentBranch(fetchImpl, repoBaseUrl, headers, branch, sha) {
  if (!isAgentBranch(branch)) return { ok: false, status: 0 };
  var res = await fetchImpl(`${repoBaseUrl}/git/refs`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: sha }),
    cache: 'no-store'
  });
  return { ok: !!(res && res.ok), status: res ? res.status : 0 };
}
