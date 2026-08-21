/**
 * The wire-encoding a NEW typed-client
 * call site uses for a `{name}` provider path param, shared between every
 * web `apiClientV2` call that reaches a federated-auth provider route
 * (`link-start` / `link-completions` GET+POST — see `packages/web/src/lib/use-auth-providers.ts`).
 *
 * Hono's client resolves a typed path param by a single verbatim string
 * substitution — it does NOT re-encode `/`, `?`, `#` for you. A provider
 * name containing one of those characters (a plugin author's `foo:bar` is
 * already supported today via the server's own single `decodeURIComponent`
 * of the raw URL segment; `/`/`?`/`#` are the ones that would otherwise
 * split the path into a different route or attach a bogus query/fragment)
 * would silently route to the WRONG endpoint if handed to the client
 * unencoded. `encodeProviderRouteSegment` is the one place that risk is
 * closed for new call sites — existing sign-in `start`/`callback` builders
 * (`packages/api/src/util/federated-auth-state.ts`) do NOT use this: they
 * already apply their OWN single `encodeURIComponent` and changing their
 * wire form would break already-registered IdP redirect URIs and the
 * sender-proof canonical message (see that module's doc comment).
 *
 * A single `encodeURIComponent(provider)` is enough: Hono's client
 * substitutes the param directly into the path template with no further
 * transformation, and the server's route matcher applies exactly ONE
 * `decodeURIComponent` when it parses the incoming URL (the same one every
 * browser-driven top-level navigation already goes through for `/start`),
 * so one encode on the way out is undone by exactly one decode on the way
 * in — never two, which would double-encode `%` itself and corrupt the
 * provider name.
 *
 * `.`/`..`/empty string are refused outright: `encodeURIComponent` does not
 * escape `.`, and a bare `.`/`..` path SEGMENT is normalized away by the
 * URL parser (dot-segment removal, RFC 3986 §5.2.4) before the request ever
 * reaches a route handler — there is no wire form that survives transport
 * for these values. This is not a NEW restriction: the existing sign-in
 * `buildProviderStartUrl` builder has always had this same blind spot (a
 * dot-only provider name is unreachable today too), so refusing it here
 * narrows nothing that used to work.
 */

/** Thrown by `encodeProviderRouteSegment` for a provider value with no safe wire form — see the module doc comment. */
export class ProviderRouteSegmentError extends Error {
  constructor(provider: string) {
    super(`encodeProviderRouteSegment: ${JSON.stringify(provider)} has no safe wire form (dot-only or empty path segments cannot survive transport)`);
    this.name = 'ProviderRouteSegmentError';
  }
}

/**
 * Encode `provider` for use as a single Hono-typed-client path segment.
 * Throws {@link ProviderRouteSegmentError} for `.`, `..`, or an empty
 * string — callers should treat that as an invalid-provider condition
 * (e.g. a 404-shaped UI error) rather than sending the request at all.
 */
export function encodeProviderRouteSegment(provider: string): string {
  if (provider === '' || provider === '.' || provider === '..') {
    throw new ProviderRouteSegmentError(provider);
  }
  return encodeURIComponent(provider);
}
