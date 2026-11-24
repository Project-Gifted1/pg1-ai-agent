/**
 * PG1's MCP registry listing (24 Nov 2026: a false "MCP registry lists
 * 1.5.1; live is 1.22.0" approval while the registry had 1.24.0):
 *   - the latest version is read reliably: version=latest when the registry
 *     answers it, else every page (25 versions, the latest on page 2), the
 *     isLatest flag on the entry's _meta, else the highest version, never
 *     the last row of a page;
 *   - a waiting listing approval the registry has caught up with closes
 *     itself ("resolved, nothing to publish") instead of offering Approve;
 *   - an approved publish is skipped when the registry already has the live
 *     version; a run that fails shows its real reason on the card.
 * No network: every fetch is stubbed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registryVersion, pickLatestVersion, waitingApprovals } from '../lib/operator/reports.mjs';
import { resolveStaleListings, publishListing, refreshPublishRun, listingState } from '../lib/operator/listing.mjs';
import { decideTask } from '../lib/operator/tasks.mjs';
import { failureLine } from '../lib/operator/merge.mjs';

const NAME = 'io.github.Project-Gifted1/pg1-threat-intel';
const ENV = { PG1_AUTONOMY: 'on' };
const OFFICIAL = 'io.modelcontextprotocol.registry/official';
// 25 versions (1.0.0 .. 1.24.0) in the registry's order: as text, the newest
// last (so page 1 of 20 ends on 1.5.0, as the live registry ended on 1.5.1).
const VERSIONS = [...Array.from({ length: 24 }, (_, i) => `1.${i}.0`).sort(), '1.24.0'];
const entry = (v, latest) => ({ server: { name: NAME, version: v }, _meta: latest === undefined ? {} : { [OFFICIAL]: { isLatest: latest } } });

// A registry that pages 20 at a time (whatever limit is asked) and, unless
// latestParam, refuses version=latest with HTTP 400.
function registry({ flag = true, latestParam = false, pageSize = 20 } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url); calls.push(u.search);
    if (u.searchParams.get('version') === 'latest') {
      if (!latestParam) return new Response('{"title":"Bad Request"}', { status: 400 });
      return Response.json({ servers: [entry('1.24.0', true)], metadata: { count: 1 } });
    }
    const start = u.searchParams.get('cursor') ? VERSIONS.indexOf(u.searchParams.get('cursor').split(':').pop()) + 1 : 0;
    const page = VERSIONS.slice(start, start + pageSize);
    const next = start + pageSize < VERSIONS.length ? `${NAME}:${page[page.length - 1]}` : undefined;
    return Response.json({ servers: page.map((v) => entry(v, flag ? v === '1.24.0' : undefined)), metadata: { count: page.length, ...(next ? { nextCursor: next } : {}) } });
  };
  return { fetchImpl, calls };
}

function memStore(tasks = []) {
  const list = tasks.map((t, i) => ({ id: `00000000-0000-4000-8000-00000000000${i + 1}`, approval: {}, ...t }));
  return {
    list,
    async listTasks({ statuses } = {}) { return list.filter((t) => !statuses || statuses.includes(t.status)); },
    async getTask(id) { return list.find((t) => t.id === id || t.id.startsWith(id)) || null; },
    async updateTask(id, patch) { Object.assign(list.find((t) => t.id === id), patch); }
  };
}
const listingTask = (over = {}) => ({ kind: 'listing', title: 'MCP registry lists 1.5.1; live is 1.22.0', status: 'needs_approval', evidence: { listed: '1.5.1', live: '1.22.0' }, approval: { action: 'directory:register', approvable: true, workflow: 'publish-mcp.yml', steps: ['a'] }, ...over });

test('25 versions, the latest (isLatest) on page 2: every page is read and 1.24.0 is found, not the last row of page 1', async () => {
  assert.equal(VERSIONS[19], '1.5.0', 'page 1 ends on a version far behind');
  assert.ok(VERSIONS.indexOf('1.24.0') >= 20, 'the latest is on page 2');
  const r = registry();
  assert.equal(await registryVersion({ fetchImpl: r.fetchImpl, name: NAME }), '1.24.0');
  assert.ok(r.calls.some((q) => q.includes('cursor=')), 'the cursor was followed');
});

test('the registry answers version=latest: one request, its flagged entry', async () => {
  const r = registry({ latestParam: true });
  assert.equal(await registryVersion({ fetchImpl: r.fetchImpl, name: NAME }), '1.24.0');
  assert.equal(r.calls.length, 1);
});

test('no isLatest flag anywhere: the highest version (semver) wins, never the last row', async () => {
  const r = registry({ flag: false });
  assert.equal(await registryVersion({ fetchImpl: r.fetchImpl, name: NAME }), '1.24.0');
  assert.equal(pickLatestVersion([{ version: '1.9.0' }, { version: '1.24.0' }, { version: '1.5.1' }]), '1.24.0');
  assert.equal(pickLatestVersion([]), null);
});

test('a stale listing approval resolves itself: not shown, not approvable, nothing run', async () => {
  const live = '1.24.0';
  const r = registry();
  const state = await listingState({ fetchImpl: r.fetchImpl, live });
  assert.deepEqual(state, { listed: '1.24.0', live, matches: true });
  const opStore = memStore([listingTask()]);
  const shown = await waitingApprovals({ opStore, autoStore: null, fetchImpl: r.fetchImpl, listingDeps: { readState: async () => state } });
  assert.deepEqual(shown, [], 'not offered for approval');
  assert.equal(opStore.list[0].status, 'done');
  assert.match(opStore.list[0].detail, /^Resolved, nothing to publish: the MCP registry already lists 1\.24\.0/);
  // Approving a stale card (a report snapshot) changes nothing and runs nothing.
  const s2 = memStore([listingTask()]);
  const dispatched = [];
  const out = await decideTask({ id: s2.list[0].id, decision: 'approve', actor: 'operator', opStore: s2, env: ENV, audit: {}, gh: { dispatch: async (w) => { dispatched.push(w); return true; } }, listingDeps: { readState: async () => state } });
  assert.equal(out.decision, 'resolved');
  assert.match(out.message, /nothing to publish/);
  assert.deepEqual(dispatched, []);
  // The registry cannot be read: nothing is closed.
  const s3 = memStore([listingTask()]);
  assert.deepEqual(await resolveStaleListings({ opStore: s3, readState: async () => { throw new Error('down'); } }), []);
  assert.equal(s3.list[0].status, 'needs_approval');
});

test('publish: skipped when the registry already has the live version; otherwise started, and the card gets the real result', async () => {
  // Already there (the 24 Nov re-run would have failed as a duplicate): not run.
  const s1 = memStore([listingTask({ status: 'approved' })]);
  const dispatched = [];
  const gh = { dispatch: async (w) => { dispatched.push(w); return true; }, findRun: async () => ({ id: 777, url: 'https://github.com/x/runs/777' }), runResult: async () => ({ status: 'completed', conclusion: 'failure', reason: failureLine('2026-11-24T07:19:11Z Error: publish failed: cannot publish duplicate version: 1.24.0 already exists\n##[error]Process completed with exit code 1.') }) };
  const skip = await publishListing({ task: s1.list[0], gh, opStore: s1, readState: async () => ({ listed: '1.24.0', live: '1.24.0', matches: true }) });
  assert.equal(skip.skipped, true);
  assert.deepEqual(dispatched, []);
  assert.match(skip.message, /nothing to publish: the MCP registry already lists 1\.24\.0.*was not run/);
  assert.equal(s1.list[0].status, 'done');
  // Behind: the run starts and is recorded; when it fails, the card says why.
  const s2 = memStore([listingTask({ status: 'approved' })]);
  const ran = await publishListing({ task: s2.list[0], gh, opStore: s2, readState: async () => ({ listed: '1.22.0', live: '1.24.0', matches: false }) });
  assert.equal(ran.ran, true);
  assert.deepEqual(dispatched, ['publish-mcp.yml']);
  assert.equal(s2.list[0].approval.run.id, 777);
  const res = await refreshPublishRun({ task: s2.list[0], gh, opStore: s2, readState: async () => ({ listed: '1.22.0', live: '1.24.0', matches: false }) });
  assert.equal(res.status, 'failed');
  assert.match(s2.list[0].detail, /run 777 failure: Error: publish failed: cannot publish duplicate version: 1\.24\.0 already exists/);
  // A run that succeeds says so, with what the registry now lists.
  const s3 = memStore([listingTask({ status: 'approved', approval: { workflow: 'publish-mcp.yml', run: { id: 778 } } })]);
  await refreshPublishRun({ task: s3.list[0], gh: { runResult: async () => ({ status: 'completed', conclusion: 'success' }) }, opStore: s3, readState: async () => ({ listed: '1.24.0', live: '1.24.0', matches: true }) });
  assert.equal(s3.list[0].status, 'done');
  assert.match(s3.list[0].detail, /Published: run 778 succeeded; the MCP registry lists 1\.24\.0/);
  // Still running: nothing changes.
  const s4 = memStore([listingTask({ status: 'approved', approval: { run: { id: 779 } } })]);
  assert.equal(await refreshPublishRun({ task: s4.list[0], gh: { runResult: async () => ({ status: 'in_progress' }) }, opStore: s4 }), null);
  assert.equal(s4.list[0].status, 'approved');
});
