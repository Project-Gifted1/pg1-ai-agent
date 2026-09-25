// Shared Supabase service-role credential lookup. Split out of api/mcp.mjs
// so lib/iocContext.mjs and the /api/ioc/context REST route can read the
// same env vars without importing api/mcp.mjs itself (which has import-time
// side effects like constructing the x402 facilitator client).

export function getSupabaseCreds() {
  const supUrl = (process.env.SUPABASE_URL || '').replace(/\s+/g, '');
  const supKey = (process.env.SUPABASEAPI_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLEKEY || '').replace(/\s+/g, '');
  if (!supUrl || !supKey) throw new Error('Supabase not configured on this deployment.');
  return { supUrl, supKey };
}
