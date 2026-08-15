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

    // Route /secure/{country} (exactly one segment after /secure) to the flag
    // handler. The regex matches a single segment on purpose, so /secure itself
    // falls through to the identity handler below.
    // decodeURIComponent handles any percent-encoding in the country value.
    const flagMatch = path.match(/^\/secure\/([^/]+)\/?$/);
    if (flagMatch) {
      return serveFlag(env, decodeURIComponent(flagMatch[1]));
    }

    // /secure -> HTML identifying the authenticated user.
    if (path === "/secure" || path === "/secure/") {
      return serveIdentity(request);
    }

    // Access already gates these routes, so anything else here is unexpected.
    return new Response("Not found", { status: 404 });
  },
};

// Builds the identity page required by the assignment:
//   "${EMAIL} authenticated at ${TIMESTAMP} from ${COUNTRY}"
// COUNTRY is rendered as a link to /secure/${COUNTRY}. All interpolated values
// are HTML-escaped (see escapeHtml) to avoid injecting markup into the page.
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

// Streams a country flag from the PRIVATE R2 bucket bound as env.FLAGS.
// The bucket has no public access; this Worker (which only runs after Access
// authentication) is the sole read path, so the assets stay private.
async function serveFlag(env, rawCountry) {
  // Objects are keyed by uppercase ISO code (e.g. KR.png) to match the value
  // returned by request.cf.country, so lookups are case-consistent.
  const country = rawCountry.toUpperCase();
  const key = `${country}.png`;

  const object = await env.FLAGS.get(key);
  if (!object) {
    // Only a subset of flags is stored; unknown countries return a clear 404.
    return new Response(`No flag stored for "${country}".`, {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const headers = new Headers();
  // Prefer the content type stored on the object; fall back to image/png.
  // (Assignment requirement: serve the flag with an appropriate Content-Type.)
  headers.set(
    "Content-Type",
    object.httpMetadata?.contentType || "image/png"
  );
  // Flags are static, so let the edge/browser cache them.
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
  // Preferred: the legacy header Access adds with the authenticated email.
  const legacy = request.headers.get("Cf-Access-Authenticated-User-Email");
  if (legacy) return legacy;

  // Fallback: decode the email claim from the Access JWT. The JWT is a signed
  // token (header.payload.signature); we only need the payload here.
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (jwt) {
    const parts = jwt.split(".");
    if (parts.length === 3) {
      try {
        // JWT payloads are base64url; convert to standard base64 before atob.
        const payload = JSON.parse(
          atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
        );
        if (payload.email) return payload.email;
      } catch (_) {
        // Malformed token — fall through to the default below.
      }
    }
  }
  // Access gates this route, so we should never reach here in practice.
  // NOTE: we trust the JWT here because Access already verified it upstream.
  // To harden, verify the signature against the team's keys at
  // https://<team>.cloudflareaccess.com/cdn-cgi/access/certs before trusting it.
  return "unknown-user";
}

// The visitor's country as determined by Cloudflare's edge. request.cf.country
// is an ISO 3166-1 alpha-2 code (e.g. "KR"), which also matches the R2 key and
// the /secure/{country} link. Falls back to the header, then "XX" if unknown.
function getCountry(request) {
  return (
    (request.cf && request.cf.country) ||
    request.headers.get("Cf-IPCountry") ||
    "XX"
  );
}

// Escape values before interpolating them into HTML to prevent markup/script
// injection. The email/country come from trusted sources here, but escaping
// user-influenced strings before rendering is a safe default.
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}
