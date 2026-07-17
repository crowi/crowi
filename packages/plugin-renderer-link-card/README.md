# @crowi/plugin-renderer-link-card

OGP link-card renderer for Crowi 2.x. Renders `@[card](url)` embeds as
a title / description / domain / image preview card, fetched via an
SSRF-guarded GET of the target page's OGP `<meta>` tags.

This is the first plugin to use the `registry.addEmbedTag(name,
renderer)` registration seam (RFC-0002 §"Phase 4") — `@[tag](url)`
dispatch, SWR caching, and error-caching are all provided by core; this
plugin only implements the `render()` callback.

## What it does

Given `@[card](https://example.com/some-article)`:

1. Fetches the URL with `GET` (no cookies / `Authorization` / other
   credentials are ever sent), following redirects manually up to 3
   hops.
2. Reads at most the first 512KB of the response body.
3. If the response is HTML, extracts `og:title` / `og:description` /
   `og:image` / `og:site_name` (falling back to `<title>` when
   `og:title` is absent) via a lightweight regex scan — no HTML parser
   dependency.
4. Renders a card:
   - Full card (title + description + domain + `og:site_name` + image)
     when `og:image` is present and resolves to an http(s) URL. The
     domain (derived from the target URL itself) is always shown;
     `og:site_name`, when present and different from the domain, is
     shown alongside it, never in place of it.
   - Text card (same fields, no image) when there's no `og:image` (or
     it's not an http(s) URL — `data:` / relative / other schemes are
     dropped, not proxied).
5. On failure (SSRF-blocked, timeout, non-2xx status, bad scheme,
   non-HTML content-type, oversized response, network error), renders
   an **error card that is still a working link** to the original
   URL — the link never loses its navigation function just because the
   preview couldn't be fetched.

`og:image` is always linked directly to the origin site — there is no
image proxy / cache (a deliberate v1 scope decision; see "Out of
scope" below).

## Install

Plugins are owned and resolved by the runner project, not `@crowi/api`
itself (`@crowi/runner` reads `crowi.config.json` and loads plugin
packages from the runner project's own `node_modules`). Bundled in the
Crowi monorepo:

```bash
# in the Crowi monorepo (dev path — apps/crowi-runner is the reference runner, @crowi/runner-app):
pnpm --filter @crowi/runner-app add @crowi/plugin-renderer-link-card
# or in a standalone runner:
npm install @crowi/plugin-renderer-link-card
```

Enable it in `crowi.config.json`:

```jsonc
{
  "plugins": ["@crowi/plugin-renderer-link-card"]
}
```

A server restart is required for plugin-list changes. There is no
per-plugin admin config for v1 — every tunable below is an internal
constant.

## Internal constants (not operator-configurable in v1)

| Constant                | Value | Notes                                              |
|-------------------------|-------|-----------------------------------------------------|
| Fetch timeout           | 5s    | Spans the whole redirect chain — including each hop's SSRF/DNS check, not just its `fetch()` call — not just a single hop. |
| Response size cap       | 512KB | Response is rejected (error card), not truncated.   |
| Max redirects           | 3     | A 4th redirect is rejected (error card).             |
| Concurrency cap         | 5     | Plugin-internal semaphore across all `@[card]` renders in this process. |
| Success cache TTL       | 1h    | OGP metadata rarely changes.                        |
| Error cache TTL         | 5min–1h | Shorter for transient failures (timeout/network/5xx), longer for failures unlikely to change soon (SSRF-blocked/bad-scheme/non-HTML content-type/4xx). |

If an admin allowlist/denylist becomes a real requirement, it belongs
in a v2 `configSchema` — out of scope here.

## SSRF guard

Before every fetch (the initial URL AND every redirect hop's
`Location` target), the hostname is validated:

- IP-literal hostnames are checked directly against blocked ranges.
- Other hostnames are resolved via `dns.lookup` and the **resolved**
  address is checked against the same ranges.
- Blocked ranges: RFC1918 private space, loopback, link-local
  (including the `169.254.169.254` cloud metadata address),
  unique-local (IPv6), carrier-grade NAT, the IETF documentation /
  benchmarking blocks, multicast, and reserved/broadcast.
- `http(s)` is the only allowed scheme — anything else (`file:`,
  `ftp:`, `javascript:`, …) is rejected immediately without a network
  call.

### Known limitation — DNS rebinding (TOCTOU)

This guard validates a hostname's resolved address **at the moment of
the check**, then hands the **hostname** (not the pinned address) to
`fetch()`. An attacker who controls DNS for the target hostname could:

1. Serve a public IP when this guard's `dns.lookup` resolves it.
2. Flip the DNS record to a private/metadata address before the
   underlying `fetch()` call performs its *own*, independent DNS
   resolution a few milliseconds later.

This is a classic DNS-rebinding / time-of-check-to-time-of-use gap.
Fully closing it requires pinning the *exact* IP address this guard
validated for the actual TCP connection — e.g. an `undici` custom
`Agent`/dispatcher that connects to the validated address directly
(with the original hostname preserved via the `Host` header / TLS SNI)
instead of letting `fetch()` re-resolve DNS. That mechanism is **not
implemented in v1** — the guard re-validates on every redirect hop
(closing the most common exploitation path, where an attacker-supplied
redirect target is the vector), but the narrow rebinding-between-check-
and-connect window on any single hop remains.

Operators with a threat model that includes an adversary who controls
DNS for arbitrary external hostnames (e.g. a very hostile multi-tenant
setup) should treat this plugin as **not yet SSRF-hardened against DNS
rebinding** and weigh that against the value of link previews. A
future revision may add the custom-dispatcher IP-pinning approach
described above.

## Sanitisation

All extracted text fields (title / description / site name) and the
domain are HTML-escaped. `og:image` is only ever emitted as an `<img
src>` when it parses as an absolute `http(s)` URL — `data:`, relative,
and other schemes are dropped (image omitted, not proxied/rewritten).
The card's own link `href` falls back to `#` if the target URL somehow
isn't `http(s)` at render time (defence in depth; `fetch-og.ts` already
gates the scheme earlier in the pipeline).

Generated markup uses only elements already on the web editor's
sanitizer allow-list (`figure` / `a` / `div` / `img` / `span` —
`packages/web/src/components/editor/known-tags.ts`), so
`stripUnknownElements` never has anything to strip from this
renderer's output.

## Cache behaviour

Caching is entirely the core's (`packages/api/src/renderer/cache`) —
this plugin only sets `cacheVersion` + per-result `ttlSec`. Bump
`LINK_CARD_CACHE_VERSION` (`src/index.ts`) whenever the rendered HTML
shape changes.

## Out of scope (v1)

- Bare-URL auto-card-ification — only the explicit `@[card](url)`
  syntax triggers a card. (The editor affordance
  (`packages/web/src/components/editor/link-card-affordance-extension.ts`)
  helps authors convert a bare URL to this syntax, but the renderer
  itself never expands one on its own.)
- Image proxy / cached image delivery — `og:image` always links
  directly to the origin site.
- Rich `iframe` embeds (YouTube etc.) — a card is the only shape v1
  ships; a distinct tag (e.g. `@[youtube]`) could add richer embeds
  later without touching this plugin.
- Admin allowlist / denylist configuration UI.
- DNS-rebinding-proof SSRF hardening (see "Known limitation" above).
