# Security Policy

## Supported versions

Only the latest released version of Browser Copilot receives security fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately through GitHub's [private vulnerability reporting](https://github.com/dcc123456/browser-copilot/security/advisories)
on this repository. Include:

- the affected component (extension, runner/server, or both),
- a minimal reproduction,
- the impact you believe it has.

We aim to acknowledge reports within 3 business days.

## Runner (`server/`) security model

The headless runner exposes an HTTP API that can start browsers and run
workflows, so it is treated as a privileged service:

- **Token required.** The runner refuses to boot without a token unless
  `BC_ALLOW_UNAUTHENTICATED=1` is set. That flag is for trusted local
  development only and prints a warning at startup.
- **Bearer-only auth.** Every `/api/*` route requires
  `Authorization: Bearer <token>`. There is deliberately **no `?token=`
  query-string fallback** — URLs leak into access logs, proxy logs, browser
  history and `Referer` headers.
- **Timing-safe comparison.** Token comparison uses
  `crypto.timingSafeEqual` (length checked first), so a wrong token is not
  distinguishable character-by-character by response time.
- **CORS allow-list.** By default only `localhost` / `127.0.0.1` / `[::1]`
  origins are reflected. Override with `BC_CORS_ORIGIN` (comma-separated, or
  `*` to allow everything — not recommended).
- **Rate limiting.** Requests are throttled per IP (default 300/minute;
  `BC_RATE_LIMIT_MAX` / `BC_RATE_LIMIT_WINDOW`). Auth is enforced in
  `preHandler`, _after_ the limiter, so brute-force attempts are counted and
  throttled rather than bypassing it.
- **Validated bodies.** `POST /api/runs`, `POST /api/hooks/:id` and
  `PUT /api/config` are validated with zod; invalid input returns a structured
  `400` with field-level `details`, never a `500`.
- **Secrets on disk.** `server/config.json` is written with `0600`
  permissions; the console API always returns secrets masked.
- **Container hygiene.** `.dockerignore` excludes `config.json`, `.env*`,
  key material and local state from the image build context.

## Extension

The extension runs entirely in the user's browser. It stores provider API keys
in `chrome.storage`; never paste a key you would not trust to the current
browser profile. The extension does not phone home.
