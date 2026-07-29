/**
 * Strips a `user:pass@` (or bare `user@`) userinfo segment before a raw URI
 * is echoed into a boot-abort / runtime error message.
 *
 * Shared by `util/env-schema.ts` (`MONGO_URI` / `REDIS_URL` / `CLIENT_URL`
 * format-check messages) and `util/redis-keyspace.ts` (feature-redis-key-prefix
 * §1 — the `CLIENT_URL`-derivation error paths embed the raw `CLIENT_URL` the
 * same way `env-schema.ts` embeds a malformed `MONGO_URI`/`REDIS_URL`, so both
 * need the same redaction). A malformed-scheme URI can still embed real
 * credentials, and these messages can reach an *uncaught* top-level exception
 * (the `Crowi` constructor throws before `app.ts`'s error handler is even
 * installed), so they can end up printed unredacted to stdout/stderr — unlike
 * the pre-existing mongoose driver's own connect-time parse error, which
 * never includes the raw connection string at all.
 */
export function redactUserinfo(raw: string): string {
  // The userinfo segment is matched with `[^@]*` (not `[^/@]*`) deliberately:
  // a malformed URI (e.g. an unclosed IPv6 host literal) can still contain a
  // stray `/` before the terminating `@` — excluding `/` from the class made
  // the whole anchored match fail on such input, silently skipping redaction
  // and leaking the credentials verbatim. Matching greedily up to the first
  // `@` regardless of `/` means a well-formed URL's userinfo (which can never
  // itself contain `/` or `@`) still redacts identically, while a malformed
  // one is redacted defensively instead of falling through unredacted.
  return raw.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^@]*@/, '$1***@');
}
