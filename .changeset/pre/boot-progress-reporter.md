---
"@crowi/api": minor
---

Add a Docker-style boot progress reporter to api startup.

The boot sequence is now grouped into four layers (core / config / services /
server) and reported as it runs. On a TTY (dev terminal) each layer shows a
live spinner that resolves to `✓ <layer> (Nms)`, followed by a `🚀 API ready
<url>` banner. On a non-TTY (prod / CI / `docker logs` / piped output) it
falls back to structured, grep-able one-line logs (`[boot] core ok (412ms)`).

A machine-readable readiness marker (`@@crowi:ready api <url>`) is emitted on
its own line in both modes. Existing boot warnings/errors (missing encryption
key, Redis connection failure, missing CLIENT_URL, fatal errors) are preserved
and no longer corrupt the live progress line. The reporter is independent of
`DEBUG`, so boot progress is visible without `DEBUG=crowi:*`; when `DEBUG` is
set it degrades to plain mode to avoid interleaving.
