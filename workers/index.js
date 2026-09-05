/**
 * PG1 Sovereign Cloudflare Edge Worker
 * Path: workers/index.js
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Health Probe Route
    if (url.pathname === '/cf-health') {
      return new Response(JSON.stringify({
        status: "ONLINE",
        platform: "Cloudflare Workers",
        engine: "workerd",
        timestamp: new Date().toISOString()
      }), {
        headers: { 
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*" 
        }
      });
    }

    // 2. Static Assets Fallback (Serves frontend if routed via Cloudflare)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("PG1 Cloudflare Worker Active", { status: 200 });
  }
};
