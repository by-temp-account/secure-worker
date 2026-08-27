# secure-worker

This project serves the Access-protected `/secure` paths of `tunnel.boyoungk-dev.xyz`
(a hostname that reaches the origin through Cloudflare Tunnel) and returns the
authenticated user's identity plus a country flag stored in a **private R2
bucket**.

| Route | Response | Content-Type |
|-------|----------|--------------|
| `GET /secure` | `${EMAIL} authenticated at ${TIMESTAMP} from ${COUNTRY}` — `${COUNTRY}` is a link to `/secure/${COUNTRY}` | `text/html` |
| `GET /secure/${COUNTRY}` | The matching country flag image from the private R2 bucket | `image/png` |

## Where this fits

```
                         ┌────────────────────────┐
   User ── HTTPS ───────▶│   Cloudflare edge       │
                         │                         │
                         │  1. Access (auth check) │  ◀── GitHub IdP
                         │  2. Worker (this repo)   │
                         │        │                 │
                         │        └── R2 (private)  │  country-flags bucket
                         └────────────────────────┘
```

- **Cloudflare Access** authenticates the request *before* it reaches the
  Worker. Unauthenticated requests to `/secure*` are redirected to the Access
  login page and never hit this code.
- The **Worker** runs on the `/secure` and `/secure/*` routes, reads the
  verified identity, and serves flag images from R2.
- The **R2 bucket is private** — it has no public access. The Worker binding
  (`env.FLAGS`) is the only path to the objects, and only for users who passed
  Access.

## Prerequisites

This Worker assumes the surrounding Cloudflare setup already exists:

1. A zone (`boyoungk-dev.xyz`) active on Cloudflare.
2. A Cloudflare Tunnel public hostname `tunnel.boyoungk-dev.xyz` routing to the
   origin web server.
3. A Cloudflare Access (self-hosted) application protecting
   `tunnel.boyoungk-dev.xyz/secure`, with a policy that allows the intended
   users and a configured IdP (GitHub here).
4. R2 enabled on the account.
5. Wrangler authenticated with an account that can edit Workers, Workers
   routes, and R2 (via `wrangler login` or a scoped API token).

## How it works

- **Email** — Access forwards the signed identity in the
  `Cf-Access-Jwt-Assertion` header. The Worker decodes the JWT payload and reads
  the `email` claim (falling back to the legacy
  `Cf-Access-Authenticated-User-Email` header).
- **Country** — taken from `request.cf.country`, the visitor's country as
  determined by Cloudflare's edge (ISO 3166-1 alpha-2, e.g. `KR`).
- **Flag** — `/secure/${COUNTRY}` looks up `${COUNTRY}.png` (uppercased) in the
  `country-flags` R2 bucket and streams it back with `image/png`. Missing
  countries return `404`.

## Project layout

```
secure-worker/
├── src/index.js     # Worker logic (routing, identity, R2 flag serving)
├── wrangler.toml    # Worker config: R2 binding + /secure routes
├── package.json
├── flags/           # source flag images uploaded to R2 (KR, US, JP)
└── README.md
```

## Configuration

`wrangler.toml` binds the private R2 bucket and attaches the Worker to the
Access-protected routes:

```toml
name = "secure-worker"
main = "src/index.js"

[[r2_buckets]]
binding = "FLAGS"
bucket_name = "country-flags"

[[routes]]
pattern = "tunnel.boyoungk-dev.xyz/secure"
zone_name = "boyoungk-dev.xyz"

[[routes]]
pattern = "tunnel.boyoungk-dev.xyz/secure/*"
zone_name = "boyoungk-dev.xyz"
```

## Deploy

```bash
# 1. Authenticate wrangler (interactive login or a Workers+R2 scoped API token)
npx wrangler login

# 2. Create the private R2 bucket
npx wrangler r2 bucket create country-flags

# 3. Upload flag images (keys are uppercase ISO country codes)
npx wrangler r2 object put country-flags/KR.png --file flags/kr.png --content-type image/png --remote
npx wrangler r2 object put country-flags/US.png --file flags/us.png --content-type image/png --remote
npx wrangler r2 object put country-flags/JP.png --file flags/jp.png --content-type image/png --remote

# 4. Deploy the Worker and its routes
npx wrangler deploy
```

## Testing

Because Access sits in front of the Worker, use a browser (or an authenticated
session), not an unauthenticated `curl`.

Unauthenticated requests should be redirected by Access:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://tunnel.boyoungk-dev.xyz/secure
# => 302  (redirect to the Access login page)
```

Authenticated in a browser:

1. Visit `https://tunnel.boyoungk-dev.xyz/secure` and sign in via the IdP.
2. Expect: `you@example.com authenticated at 2026-…Z from KR`, where `KR` is a
   link.
3. Click the link (`/secure/KR`) to see the flag image served from R2.

## Security notes

- The R2 bucket is **private**; objects are never served directly. All reads go
  through this Worker, which only runs for Access-authenticated users.
- The Worker trusts identity from the Access JWT header. In a hardened setup the
  JWT signature can be verified against the team's public keys at
  `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` before use.
- Flag images are sourced from a public flag CDN and stored in R2 for the demo.
