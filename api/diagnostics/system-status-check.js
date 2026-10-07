import { createClient } from '@supabase/supabase-js';
import { filterServableRows } from '../../lib/sourcePolicy.mjs';
import { resolveOperatorSession } from '../../lib/operatorSession.mjs';

export const config = {
  maxDuration: 60,
};

const diagnosticMode = 'FULL_SCAN';
const verifyDatabaseTables = true;
const checkActiveWorkers = true;

const ALLOWED_TABLES = [
  'threat_indicators',
  'threat_logs',
  'telemetry_stream',
  'nodes',
  'system_events',
  'api_usage'
];

// Tables that may hold threat indicators. Their rows are returned only when
// lib/sourcePolicy.mjs says their source may be served; a row with no
// verification_source counts as unattributed and is withheld by default.
const INDICATOR_TABLES = new Set(['threat_indicators', 'threat_logs', 'telemetry_stream']);
const servableRows = (table, rows) => (INDICATOR_TABLES.has(table) ? filterServableRows(rows || []) : (rows || []));

// Operator only: the same session check as the operator chat commands
// (lib/operatorSession.mjs). Send the credentials as `Authorization: Basic`
// on GET, or as { user, pass, table, metric, limit } on POST. Anyone else
// gets a 401 before any table is read, with no payload beyond the error, and
// nothing is logged.
function requestBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  return body && typeof body === 'object' ? body : {};
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).json({
      error: 'Method Not Allowed',
      message: `HTTP ${req.method} is not supported on this endpoint.`
    });
  }

  const session = resolveOperatorSession(req);
  if (session.rateLimited) {
    return res.status(429).json({ error: 'Too many failed authentication attempts. Try again in 15 minutes.' });
  }
  if (!session.isOperator) {
    res.setHeader('WWW-Authenticate', 'Basic realm="pg1-operator"');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startTime = Date.now();

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    // Strictly mapped to your GitHub Actions environment variables
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLEKEY;

    const hasSupabaseUrl = Boolean(supabaseUrl);
    const hasSupabaseKey = Boolean(supabaseKey);
    const hasOtxApi = Boolean(process.env.OTX_API);
    const hasOtxApiKey = Boolean(process.env.OTX_API_KEY);
    const hasAbuseIpDbApi = Boolean(process.env.ABUSEIPDB_API);
    const hasNvdApi = Boolean(process.env.NVD_API);

    const params = req.method === 'POST' ? requestBody(req) : (req.query || {});
    const { table, metric = 'summary', limit = '10' } = params;

    const diagnosticPayload = {
      system: 'PG1-AGENT-SOVEREIGN-CORE',
      version: '10.0',
      diagnosticMode,
      verifyDatabaseTables,
      checkActiveWorkers,
      timestamp: new Date().toISOString(),
      uptimeSec: process.uptime(),
      environment: {
        SUPABASE_URL_Configured: hasSupabaseUrl,
        SUPABASE_SERVICE_KEY_Configured: hasSupabaseKey,
        OTX_API_Configured: hasOtxApi,
        OTX_API_KEY_Configured: hasOtxApiKey,
        ABUSEIPDB_API_Configured: hasAbuseIpDbApi,
        NVD_API_Configured: hasNvdApi
      }
    };

    if (!table) {
      return res.status(200).json({
        ...diagnosticPayload,
        status: 'HEALTHY',
        mode: 'SYSTEM_AUDIT',
        supportedTables: ALLOWED_TABLES,
        queryExamples: [
          '/api/diagnostics/system-status-check?table=threat_indicators&metric=count',
          '/api/diagnostics/system-status-check?table=threat_logs&metric=records&limit=5'
        ],
        executionDurationMs: Date.now() - startTime
      });
    }

    if (!ALLOWED_TABLES.includes(table)) {
      return res.status(400).json({
        error: 'Invalid Table Request',
        message: `Table '${table}' is not authorized. Allowed tables: ${ALLOWED_TABLES.join(', ')}`,
        executionDurationMs: Date.now() - startTime
      });
    }

    if (!hasSupabaseUrl || !hasSupabaseKey) {
      return res.status(503).json({
        error: 'Database Unavailable',
        message: 'SUPABASE_URL, SUPABASE_SERVICE_KEY, or SUPABASE_SERVICE_ROLEKEY is not configured in environment variables.',
        environment: diagnosticPayload.environment,
        executionDurationMs: Date.now() - startTime
      });
    }

    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false }
    });

    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);

    if (metric === 'count') {
      const { count, error } = await supabase
        .from(table)
        .select('*', { count: 'exact', head: true });

      if (error) {
        return res.status(500).json({
          error: 'Supabase Query Error',
          table,
          details: error.message,
          executionDurationMs: Date.now() - startTime
        });
      }

      return res.status(200).json({
        ...diagnosticPayload,
        status: 'SUCCESS',
        mode: 'LIVE_COUNT',
        table,
        rowCount: count ?? 0,
        executionDurationMs: Date.now() - startTime
      });
    }

    if (metric === 'records') {
      const { data, count, error } = await supabase
        .from(table)
        .select('*', { count: 'exact' })
        .limit(parsedLimit);

      if (error) {
        return res.status(500).json({
          error: 'Supabase Query Error',
          table,
          details: error.message,
          executionDurationMs: Date.now() - startTime
        });
      }

      return res.status(200).json({
        ...diagnosticPayload,
        status: 'SUCCESS',
        mode: 'LIVE_RECORDS',
        table,
        totalRowCount: count ?? 0,
        returnedCount: servableRows(table, data).length,
        records: servableRows(table, data),
        executionDurationMs: Date.now() - startTime
      });
    }

    const [countResult, sampleResult] = await Promise.all([
      supabase.from(table).select('*', { count: 'exact', head: true }),
      supabase.from(table).select('*').limit(3)
    ]);

    if (countResult.error) {
      return res.status(500).json({
        error: 'Supabase Count Error',
        table,
        details: countResult.error.message,
        executionDurationMs: Date.now() - startTime
      });
    }

    return res.status(200).json({
      ...diagnosticPayload,
      status: 'SUCCESS',
      mode: 'TABLE_SUMMARY',
      table,
      totalRowCount: countResult.count ?? 0,
      sampleRecords: servableRows(table, sampleResult.data),
      executionDurationMs: Date.now() - startTime
    });

  } catch (err) {
    return res.status(500).json({
      status: 'CRITICAL_FAILURE',
      error: err.message || 'Internal Server Error',
      executionDurationMs: Date.now() - startTime
    });
  }
}
