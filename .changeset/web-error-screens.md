---
"@crowi/web": minor
---

Harden the web app against server outages, hung connections, and render
exceptions so it no longer gets stuck on a permanent "Loading…" or a blank
white screen.

- `apiV2Fetch` (and the `refreshAccessToken` raw fetch) now carry an
  `AbortController` timeout (default 20s, overridable via
  `NEXT_PUBLIC_API_TIMEOUT_MS`). A hung response is aborted and surfaced as a
  network error instead of spinning forever. The timeout signal is composed
  with any caller-supplied `signal`, so existing react-query cancellation and
  user-initiated aborts keep working and are not misclassified as connection
  failures.
- Added App Router error boundaries: `app/error.tsx` renders a themed error
  card with a reload action for route-segment render exceptions, and
  `app/global-error.tsx` provides a locale-independent fallback screen when the
  root layout itself throws.
- Query errors are now aggregated into the existing `ConnectionProvider` via
  `QueryCache.onError`: network/timeout aborts raise the connection banner and
  5xx responses raise the server-error modal, while 401 stays delegated to the
  token-refresh interceptor. react-query retry is tuned to fail fast on 4xx and
  retry network/5xx a small number of times, so spinners resolve into a clear
  error state quickly.
