// Cloudflare Pages Function — proxies requests to the Anthropic API
// Includes server-side caching so repeat product searches are free & instant

const CACHE_TTL = 7 * 24 * 60 * 60; // 7 days in seconds
const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

// Extract a cache key from the request body (product name from the prompt)
function extractCacheKey(body) {
  try {
    const msg = body?.messages?.[0]?.content;
    if (typeof msg !== "string") return null;
    // Match patterns like: product: "Name" or product: "${name}"
    const match = msg.match(/product[:\s]*"([^"]+)"/i);
    if (match) return "hs_" + match[1].toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").slice(0, 100);
  } catch {}
  return null;
}

export async function onRequestPost(context) {
  const apiKey = context.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "API key not configured" }), {
      status: 500, headers: CORS_HEADERS,
    });
  }

  try {
    const body = await context.request.json();
    const cacheKey = extractCacheKey(body);

    // Check server cache (Cloudflare edge cache)
    if (cacheKey) {
      try {
        const cache = caches.default;
        const cacheUrl = new URL("https://hs-cache.internal/" + cacheKey);
        const cacheRequest = new Request(cacheUrl.toString());
        const cachedResponse = await cache.match(cacheRequest);
        if (cachedResponse) {
          const cachedData = await cachedResponse.text();
          return new Response(cachedData, {
            status: 200,
            headers: { ...CORS_HEADERS, "X-Cache": "HIT", "X-Cache-Key": cacheKey },
          });
        }
      } catch (cacheErr) {
        // Cache read failed, proceed to API
        console.log("Cache read error:", cacheErr.message);
      }
    }

    // No cache hit — call Anthropic API
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    const responseBody = JSON.stringify(data);

    // Cache successful responses on the server
    if (cacheKey && response.status === 200) {
      try {
        const cache = caches.default;
        const cacheUrl = new URL("https://hs-cache.internal/" + cacheKey);
        const cacheRequest = new Request(cacheUrl.toString());
        const cacheResponse = new Response(responseBody, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=" + CACHE_TTL,
          },
        });
        context.waitUntil(cache.put(cacheRequest, cacheResponse));
      } catch (cacheErr) {
        console.log("Cache write error:", cacheErr.message);
      }
    }

    return new Response(responseBody, {
      status: response.status,
      headers: { ...CORS_HEADERS, "X-Cache": "MISS", "X-Cache-Key": cacheKey || "none" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: CORS_HEADERS,
    });
  }
}

// Handle CORS preflight
export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
