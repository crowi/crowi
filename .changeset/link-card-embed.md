---
'@crowi/plugin-renderer-link-card': minor
'@crowi/web': minor
---

Add `@[card](url)` link-card embeds with editor affordance.

New `@crowi/plugin-renderer-link-card` plugin: the first user of the `registry.addEmbedTag(name, renderer)` embed-tag registration seam (RFC-0002). Writing `@[card](url)` fetches the target page's OGP meta tags (`og:title` / `og:description` / `og:image` / `og:site_name`) and renders a title / description / domain / image preview card. A page with no `og:image` renders as a text-only card; a fetch failure (timeout, non-2xx, blocked, bad scheme, oversized response) degrades to a minimal error card that is still a working link to the original URL. The fetch is SSRF-guarded (rejects private / loopback / link-local / unique-local / metadata addresses, whether specified directly, via DNS resolution, or via a redirect target — each of up to 3 manual redirect hops is re-validated), time-capped at 5s, size-capped at 512KB, and concurrency-capped at 5 simultaneous fetches. `og:image` is always linked directly to the source site (no proxying or caching).

The web editor gains a hover/focus affordance that converts a bare `http(s)://` URL to `@[card](url)` and back, leaving an already-labelled `[label](url)` link untouched.
