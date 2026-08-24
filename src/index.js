/**
 * Project Gifted1™ - Cloudflare Worker CORS Relay for Replicate Video Pipeline
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Prefer, X-Requested-With",
  "Access-Control-Max-Age": "86400",
};

function handleOptions(request) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return handleOptions(request);
    }

    try {
      const url = new URL(request.url);

      // Status / Health Check
      if (request.method === "GET" && url.pathname === "/" && !url.searchParams.has("url")) {
        return new Response(
          JSON.stringify({ status: "online", service: "PG1 Replicate CORS Relay", version: "12.28" }),
          {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
            },
          }
        );
      }

      // Determine target URL for Replicate API
      let targetUrl = "https://api.replicate.com/v1/models/lucataco/hotshot-xl/predictions";

      if (url.searchParams.has("url")) {
        targetUrl = url.searchParams.get("url");
      } else if (url.pathname.startsWith("/v1/predictions/")) {
        const predictionId = url.pathname.replace("/v1/predictions/", "");
        targetUrl = `https://api.replicate.com/v1/predictions/${predictionId}`;
      } else if (url.pathname.startsWith("/predictions/")) {
        const predictionId = url.pathname.replace("/predictions/", "");
        targetUrl = `https://api.replicate.com/v1/predictions/${predictionId}`;
      }

      // Prepare headers for upstream Replicate API
      const authHeader = request.headers.get("Authorization") || (env && env.REPLICATE_API_TOKEN ? `Bearer ${env.REPLICATE_API_TOKEN}` : "");
      const preferHeader = request.headers.get("Prefer") || "wait";

      const forwardHeaders = {
        "Content-Type": "application/json",
      };

      if (authHeader) {
        forwardHeaders["Authorization"] = authHeader;
      }
      if (preferHeader) {
        forwardHeaders["Prefer"] = preferHeader;
      }

      // Fetch options
      const fetchOptions = {
        method: request.method,
        headers: forwardHeaders,
      };

      if (request.method === "POST" || request.method === "PUT") {
        const reqBody = await request.text();
        fetchOptions.body = reqBody;
      }

      // Execute request to Replicate API
      const replicateResponse = await fetch(targetUrl, fetchOptions);
      const responseBody = await replicateResponse.text();

      // Return response to frontend with complete CORS headers
      return new Response(responseBody, {
        status: replicateResponse.status,
        headers: {
          ...corsHeaders,
          "Content-Type": replicateResponse.headers.get("Content-Type") || "application/json",
        },
      });
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
