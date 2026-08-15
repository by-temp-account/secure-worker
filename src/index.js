/**
 * Cloudflare Worker for the SE assignment.
 *
 * Runs on the Access-protected paths of tunnel.boyoungk-dev.xyz:
 *
 *   GET /secure
 *     Returns HTML identifying the authenticated user:
 *       "${EMAIL} authenticated at ${TIMESTAMP} from ${COUNTRY}"
 *     ${COUNTRY} is a link to /secure/${COUNTRY}.
 *
 *   GET /secure/${COUNTRY}
 *     Returns the matching country flag image, stored in a PRIVATE R2 bucket,
 *     served with the correct Content-Type.
 *
 * Cloudflare Access enforces authentication before the request reaches this
 * Worker, and forwards the identity in the `Cf-Access-Jwt-Assertion` header.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // /secure/{country} -> serve the flag image from the private R2 bucket.
    const flagMatch = path.match(/^\/secure\/([^/]+)\/?$/);
    if (flagMatch) {
      return serveFlag(env, decodeURIComponent(flagMatch[1]));
    }

    // /secure -> HTML with the authenticated user's identity.
    if (path === "/secure" || path === "/secure/") {
      return serveIdentity(request);
    }

    return new Response("Not found", { status: 404 });
  },
};

function serveIdentity(request) {
  const email = getAuthenticatedEmail(request);
  const country = getCountry(request);
  const timestamp = new Date().toISOString();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Secure area</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 3rem; line-height: 1.6; }
    a { font-weight: 600; }
  </style>
</head>
<body>
  <p>${escapeHtml(email)} authenticated at ${escapeHtml(timestamp)} from
     <a href="/secure/${encodeURIComponent(country)}">${escapeHtml(country)}</a></p>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function serveFlag(env, rawCountry) {
  const country = rawCountry.toUpperCase();
  const key = `${country}.png`;

  const object = await env.FLAGS.get(key);
  if (!object) {
    return new Response(`No flag stored for "${country}".`, {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const headers = new Headers();
  headers.set(
    "Content-Type",
    object.httpMetadata?.contentType || "image/png"
  );
  headers.set("Cache-Control", "public, max-age=3600");
  if (object.httpEtag) headers.set("ETag", object.httpEtag);

  return new Response(object.body, { headers });
}

/**
 * Extract the authenticated email. Access injects a signed JWT in the
 * `Cf-Access-Jwt-Assertion` header; the email is in its payload. We also
 * check the legacy `Cf-Access-Authenticated-User-Email` header as a fallback.
 */
function getAuthenticatedEmail(request) {
  const legacy = request.headers.get("Cf-Access-Authenticated-User-Email");
  if (legacy) return legacy;

  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (jwt) {
    const parts = jwt.split(".");
    if (parts.length === 3) {
      try {
        const payload = JSON.parse(
          atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
        );
        if (payload.email) return payload.email;
      } catch (_) {
        // fall through
      }
    }
  }
  return "unknown-user";
}

function getCountry(request) {
  return (
    (request.cf && request.cf.country) ||
    request.headers.get("Cf-IPCountry") ||
    "XX"
  );
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}
