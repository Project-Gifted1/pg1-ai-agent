/**
 * Project Gifted1™ - Cloudflare Worker CORS Relay & Multi-Provider Media Pipeline
 * Version 12.30 - Routing, Caching, and Cost Metadata
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Prefer, X-Requested-With",
  "Access-Control-Max-Age": "86400",
};

const MEDIA_MODEL_ROUTES = {
  kling: "https://api.replicate.com/v1/models/lucataco/hotshot-xl/predictions",
  pixverse: "https://api.replicate.com/v1/models/lucataco/animate-diff/predictions",
  cogvideox: "https://api.replicate.com/v1/models/thudm/cogvideox-5b/predictions",
  flux: "https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions",
  sdxl: "https://api.replicate.com/v1/models/stability-ai/sdxl/predictions",
  "stable-diffusion": "https://api.replicate.com/v1/models/stability-ai/sdxl/predictions"
};

const MEDIA_MODEL_ESTIMATED_COST = {
  kling: "0.032/sec",
  pixverse: "0.067/sec",
  cogvideox: "0.010-0.030/sec",
  flux: "0.003/image",
  sdxl: "0.002-0.004/image",
  "stable-diffusion": "0.002-0.004/image"
};

function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return handleOptions();
    }

    try {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/" && !url.searchParams.has("url")) {
        return new Response(
          JSON.stringify({
            status: "online",
            service: "PG1 Replicate CORS Relay & Multi-Provider Media Pipeline",
            version: "12.30",
            capabilities: ["kling", "pixverse", "cogvideox", "flux", "sdxl", "auto-failover", "cache"]
          }),
          {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
            },
          }
        );
      }

      if (url.searchParams.has("download") && url.searchParams.has("url")) {
        const mediaUrl = url.searchParams.get("url");
        const mediaRes = await fetch(mediaUrl);
        const headers = new Headers(corsHeaders);
        headers.set("Content-Type", mediaRes.headers.get("Content-Type") || "video/mp4");
        headers.set("Content-Disposition", `attachment; filename="pg1-media-${Date.now()}"`);
        return new Response(mediaRes.body, {
          status: mediaRes.status,
          headers
        });
      }

      let selectedModel = (url.searchParams.get("model") || "kling").toLowerCase();
      let targetUrl = MEDIA_MODEL_ROUTES[selectedModel] || MEDIA_MODEL_ROUTES.kling;

      if (url.searchParams.has("url")) {
        targetUrl = url.searchParams.get("url");
      } else if (url.pathname.startsWith("/v1/predictions/")) {
        const predictionId = url.pathname.replace("/v1/predictions/", "");
        targetUrl = `https://api.replicate.com/v1/predictions/${predictionId}`;
      } else if (url.pathname.startsWith("/predictions/")) {
        const predictionId = url.pathname.replace("/predictions/", "");
        targetUrl = `https://api.replicate.com/v1/predictions/${predictionId}`;
      }

      const authHeader = request.headers.get("Authorization")
        || (env && env.REPLICATE_API_TOKEN ? ("Bearer " + env.REPLICATE_API_TOKEN) : "");
      const preferHeader = request.headers.get("Prefer") || "wait";

      const forwardHeaders = {
        "Content-Type": "application/json",
      };

      if (authHeader) {
        forwardHeaders.Authorization = authHeader;
      }
      if (preferHeader) {
        forwardHeaders.Prefer = preferHeader;
      }

      const fetchOptions = {
        method: request.method,
        headers: forwardHeaders
      };

      const shouldCache = request.method === "GET" && !url.searchParams.has("download");
      const cache = caches.default;
      if (shouldCache) {
        const cachedResponse = await cache.match(request);
        if (cachedResponse) {
          const hitResponse = new Response(cachedResponse.body, cachedResponse);
          hitResponse.headers.set("X-PG1-Cache", "HIT");
          return hitResponse;
        }
      }

      if (request.method === "POST" || request.method === "PUT") {
        let reqBodyText = await request.text();

        try {
          const parsed = JSON.parse(reqBodyText);
          if (parsed && parsed.model && typeof parsed.model === "string") {
            selectedModel = parsed.model.toLowerCase();
            if (MEDIA_MODEL_ROUTES[selectedModel]) {
              targetUrl = MEDIA_MODEL_ROUTES[selectedModel];
            }
          }
          if (parsed && !parsed.input && parsed.prompt) {
            reqBodyText = JSON.stringify({
              input: {
                prompt: parsed.prompt,
                negative_prompt: parsed.negative_prompt || "blurry, low quality, distorted",
                steps: parsed.steps || 30
              }
            });
          }
        } catch (error) {
          // Keep raw text if not JSON
        }

        fetchOptions.body = reqBodyText;
      }

      const replicateResponse = await fetch(targetUrl, fetchOptions);

      if (!replicateResponse.ok && (request.method === "POST" || request.method === "PUT")) {
        try {
          const bodyJson = JSON.parse(fetchOptions.body);
          const prompt = bodyJson?.input?.prompt || bodyJson?.prompt || "Cinematic video generation";
          const fallbackUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?model=flux&nologo=true`;

          return new Response(
            JSON.stringify({
              status: "succeeded",
              fallback: true,
              output: [fallbackUrl],
              model: "pollinations-flux-fallback",
              cost_estimate: "free",
              message: "Primary provider unavailable. Auto-routed to fallback."
            }),
            {
              status: 200,
              headers: {
                ...corsHeaders,
                "Content-Type": "application/json",
              },
            }
          );
        } catch (_) {
          // continue with upstream response
        }
      }

      const responseBody = await replicateResponse.text();
      const response = new Response(responseBody, {
        status: replicateResponse.status,
        headers: {
          ...corsHeaders,
          "Content-Type": replicateResponse.headers.get("Content-Type") || "application/json",
          "X-PG1-Model": selectedModel,
          "X-PG1-Cost-Estimate": MEDIA_MODEL_ESTIMATED_COST[selectedModel] || "n/a",
        },
      });

      if (shouldCache && replicateResponse.ok) {
        response.headers.set("X-PG1-Cache", "MISS");
        ctx.waitUntil(cache.put(request, response.clone()));
      }

      return response;
    } catch (err) {
      return new Response(
        JSON.stringify({ error: true, message: err.message || "Relay internal error" }),
        {
          status: 500,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }
  },
};
