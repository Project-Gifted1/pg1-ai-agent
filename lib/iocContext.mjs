// Shared get_ioc_context / get_ioc_batch lookup logic. Split out of
// api/mcp.mjs so the feature-flagged GET /api/ioc/context REST route can
// reuse the exact same lookup without importing api/mcp.mjs itself (which
// has import-time side effects like constructing the x402 facilitator
// client for the MCP route).

export function detectIndicatorType(value) {
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) return 'IPv4';
  if (/^[a-fA-F0-9]{32}$|^[a-fA-F0-9]{40}$|^[a-fA-F0-9]{64}$/.test(value)) return 'hash';
  if (/^https?:\/\//i.test(value)) return 'URL';
  return 'domain';
}

export async function lookupIocContext(value, supUrl, supKey) {
  let res;
  try {
    res = await fetch(
      `${supUrl}/rest/v1/threat_ioc_telemetry?value=eq.${encodeURIComponent(value)}&select=*&order=last_seen.desc`,
      { headers: { apikey: supKey, Authorization: `Bearer ${supKey}` } }
    );
  } catch (netErr) {
    const err = new Error('Threat data temporarily unavailable, please retry.');
    err.serviceUnavailable = true;
    throw err;
  }
  if (!res.ok) {
    const err = new Error('Threat data temporarily unavailable, please retry.');
    err.serviceUnavailable = true;
    throw err;
  }
  const rows = await res.json();

  if (!rows.length) {
    return { indicator: value, found: false };
  }

  const sources = rows.map((r) => ({
    source: r.verification_source || 'unknown',
    confidence: parseInt(r.confidence_score, 10) || 0,
    first_seen: r.ingested_at || null,
    last_seen: r.last_seen || null,
    malware_family: r.malware_family || null,
    tags: r.tags || []
  }));

  const confidences = sources.map((s) => s.confidence).filter((c) => c > 0);
  const avgConfidence = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0;
  const agreementBoost = Math.min(20, Math.max(0, sources.length - 1) * 7);
  const aggregateConfidence = Math.round(Math.min(100, avgConfidence + agreementBoost));

  const malwareFamilies = [...new Set(sources.map((s) => s.malware_family).filter(Boolean))];
  const tags = [...new Set(sources.flatMap((s) => s.tags || []))];

  const firstSeenTimes = sources.map((s) => s.first_seen).filter(Boolean).map((t) => new Date(t).getTime()).filter((t) => !isNaN(t));
  const lastSeenTimes = sources.map((s) => s.last_seen).filter(Boolean).map((t) => new Date(t).getTime()).filter((t) => !isNaN(t));

  return {
    indicator: value,
    found: true,
    indicator_type: rows[0].indicator_type || detectIndicatorType(value),
    provenance: {
      sources: [...new Set(sources.map((s) => s.source))],
      observation_count: rows.length,
      confidence_score: aggregateConfidence,
      malware_families: malwareFamilies,
      tags,
      first_seen: firstSeenTimes.length ? new Date(Math.min(...firstSeenTimes)).toISOString() : null,
      last_seen: lastSeenTimes.length ? new Date(Math.max(...lastSeenTimes)).toISOString() : null
    }
  };
}
