'use strict';

const DEFAULT_PIPELINE_REPO = {
  owner: 'Project-Gifted1',
  repo: 'sovereign-threat-pipeline'
};

const CANDIDATE_STATUS_PATHS = [
  'telemetry/pipeline-status.json',
  'status/pipeline-status.json',
  'pipeline-status.json'
];

function normalizeState(value) {
  const lowered = String(value || '').toLowerCase();
  if (lowered === 'healthy' || lowered === 'ok' || lowered === 'success' || lowered === 'online') return 'healthy';
  if (lowered === 'offline' || lowered === 'unavailable') return 'offline';
  if (lowered === 'degraded' || lowered === 'error' || lowered === 'failed' || lowered === 'failure') return 'degraded';
  return '';
}

function readTimestamp(primary, fallback) {
  return primary || fallback || null;
}

function readQueueDepth(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePipelineTelemetry(rawTelemetry, context = {}) {
  const raw = rawTelemetry && typeof rawTelemetry === 'object' ? rawTelemetry : {};

  const lastRunTime = readTimestamp(raw.lastRunTime || raw.last_run_time || raw.lastRun, context.workflowRunTime);
  const lastSuccessfulSync = readTimestamp(
    raw.lastSuccessfulUpload || raw.last_successful_upload || raw.lastSuccessfulSync || raw.last_successful_sync,
    context.workflowSuccessTime
  );

  const queueDepth = readQueueDepth(raw.queueDepth ?? raw.queue_depth ?? raw.pendingWork ?? raw.pending_work);
  const currentErrorState =
    raw.currentErrorState || raw.current_error_state || raw.errorState || raw.error ||
    (context.workflowConclusion && context.workflowConclusion !== 'success' ? context.workflowConclusion : null);

  const configReady = raw.configReady ?? raw.config_ready ?? null;
  const secretsReady = raw.secretsReady ?? raw.secrets_ready ?? null;

  const hintedState = normalizeState(raw.state || raw.health || context.state);
  const state = hintedState || (context.offline
    ? 'offline'
    : currentErrorState
      ? 'degraded'
      : lastRunTime
        ? 'healthy'
        : 'offline');

  return {
    state,
    lastRunTime,
    lastSuccessfulSync,
    currentErrorState,
    queueDepth,
    configReady,
    secretsReady
  };
}

async function fetchJsonStatusFromRepo({ owner, repo, token, fetchFn }) {
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'pg1-ai-agent-pipeline-telemetry'
  };

  if (token) {
    headers.Authorization = `token ${token}`;
  }

  for (const path of CANDIDATE_STATUS_PATHS) {
    const response = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
      headers
    });

    if (!response.ok) {
      continue;
    }

    const body = await response.json();
    if (!body || !body.content) {
      continue;
    }

    try {
      const decoded = Buffer.from(body.content, 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      return { parsed, sourcePath: path };
    } catch (_) {
      return { parsed: null, sourcePath: path };
    }
  }

  return { parsed: null, sourcePath: null };
}

async function fetchLatestWorkflowRun({ owner, repo, token, fetchFn }) {
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'pg1-ai-agent-pipeline-telemetry'
  };

  if (token) {
    headers.Authorization = `token ${token}`;
  }

  const response = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/actions/runs?per_page=5`, { headers });
  if (!response.ok) {
    return null;
  }

  const body = await response.json();
  const runs = Array.isArray(body?.workflow_runs) ? body.workflow_runs : [];
  if (!runs.length) {
    return null;
  }

  const lastRun = runs[0];
  const lastSuccess = runs.find((run) => run.conclusion === 'success');

  return {
    workflowRunTime: lastRun.run_started_at || lastRun.created_at || null,
    workflowConclusion: lastRun.conclusion || null,
    workflowSuccessTime: lastSuccess ? (lastSuccess.updated_at || lastSuccess.run_started_at || lastSuccess.created_at) : null
  };
}

async function getPipelineTelemetrySnapshot({ env = process.env, fetchFn = fetch } = {}) {
  const owner = env.PIPELINE_REPO_OWNER || DEFAULT_PIPELINE_REPO.owner;
  const repo = env.PIPELINE_REPO_NAME || DEFAULT_PIPELINE_REPO.repo;
  const token = (env.GITHUB_TOKEN || env.GH_TOKEN || '').trim();

  try {
    const [{ parsed, sourcePath }, workflowMeta] = await Promise.all([
      fetchJsonStatusFromRepo({ owner, repo, token, fetchFn }),
      fetchLatestWorkflowRun({ owner, repo, token, fetchFn })
    ]);

    const hasAnySignal = Boolean(parsed) || Boolean(workflowMeta);
    const normalized = normalizePipelineTelemetry(parsed, {
      offline: !hasAnySignal,
      ...workflowMeta
    });

    return {
      sourceRepo: `${owner}/${repo}`,
      sourcePath,
      telemetryAvailable: hasAnySignal,
      checkedAt: new Date().toISOString(),
      controls: {
        canRequestSync: env.PIPELINE_ALLOW_DISPATCH === 'true',
        requiresConfirmation: true
      },
      ...normalized
    };
  } catch (error) {
    return {
      sourceRepo: `${owner}/${repo}`,
      sourcePath: null,
      telemetryAvailable: false,
      checkedAt: new Date().toISOString(),
      controls: {
        canRequestSync: env.PIPELINE_ALLOW_DISPATCH === 'true',
        requiresConfirmation: true
      },
      state: 'offline',
      lastRunTime: null,
      lastSuccessfulSync: null,
      currentErrorState: `telemetry unavailable: ${error.message}`,
      queueDepth: null,
      configReady: null,
      secretsReady: null
    };
  }
}

async function requestPipelineSync({
  confirmed,
  reason,
  env = process.env,
  fetchFn = fetch
} = {}) {
  const owner = env.PIPELINE_REPO_OWNER || DEFAULT_PIPELINE_REPO.owner;
  const repo = env.PIPELINE_REPO_NAME || DEFAULT_PIPELINE_REPO.repo;

  if (!confirmed) {
    return {
      ok: false,
      status: 400,
      message: 'Confirmation required before requesting a pipeline sync.'
    };
  }

  if (env.PIPELINE_ALLOW_DISPATCH !== 'true') {
    return {
      ok: false,
      status: 403,
      message: 'Manual dispatch is disabled by policy. Read-only telemetry is still available.'
    };
  }

  const token = (env.GITHUB_TOKEN || env.GH_TOKEN || '').trim();
  if (!token) {
    return {
      ok: false,
      status: 503,
      message: 'Missing GitHub token for workflow dispatch.'
    };
  }

  const workflowId = env.PIPELINE_WORKFLOW_ID || '';
  if (!workflowId) {
    return {
      ok: false,
      status: 503,
      message: 'Missing PIPELINE_WORKFLOW_ID for workflow dispatch.'
    };
  }

  const ref = env.PIPELINE_WORKFLOW_REF || 'main';
  const response = await fetchFn(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`,
    {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `token ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'pg1-ai-agent-pipeline-telemetry'
      },
      body: JSON.stringify({
        ref,
        inputs: {
          requested_by: 'pg1-ai-agent',
          reason: String(reason || 'manual operator request').slice(0, 120)
        }
      })
    }
  );

  if (!response.ok) {
    let details = '';
    try {
      const body = await response.json();
      details = body?.message ? ` (${body.message})` : '';
    } catch (_) {
      // ignore parse error
    }

    return {
      ok: false,
      status: response.status,
      message: `Workflow dispatch failed${details}`
    };
  }

  return {
    ok: true,
    status: 202,
    message: `Workflow dispatch requested for ${owner}/${repo}.`
  };
}

module.exports = {
  normalizePipelineTelemetry,
  getPipelineTelemetrySnapshot,
  requestPipelineSync
};
