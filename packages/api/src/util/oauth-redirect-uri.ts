import type { OAuthClientDocument } from 'src/models/oauth-client';

/**
 * RFC-0010 §Security — redirect_uri validation for the Auth Code flow.
 * RFC-0016 §4.4/§14 — trusted first-party clients may additionally
 * register a custom URI scheme.
 *
 * Three rules:
 *
 *  - **Trusted first-party custom scheme** (`client.trusted &&
 *    client.firstParty`): the requested URI is accepted only on an exact
 *    string match against one of the client's registered `redirectUris` —
 *    no normalization, no partial match, no wildcard. This is the only
 *    way a non-http(s) scheme (e.g. the iOS app's `crowi-ios://callback`)
 *    is ever accepted, and it runs before the http(s)-only guard below.
 *    Every other client (including the non-trusted `crowi-cli`) is
 *    unaffected and falls through to the rules below unchanged.
 *  - **Loopback** (`127.0.0.1` / `localhost`, http): allowed if the client
 *    registered a matching loopback host, *regardless of port*. Native /
 *    CLI clients bind an ephemeral loopback port per login (RFC 8252
 *    §7.3), so the port cannot be pre-registered; the host match is the
 *    security boundary.
 *  - **Everything else**: must match one of the client's `redirectUris`
 *    exactly (string equality), preventing open-redirect to an attacker
 *    origin.
 *
 * Anything that does not parse as a URL is rejected outright (before any
 * of the rules above run).
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

export function isRedirectUriAllowed(client: Pick<OAuthClientDocument, 'redirectUris' | 'trusted' | 'firstParty'>, requestedUri: string): boolean {
  let requested: URL;
  try {
    requested = new URL(requestedUri);
  } catch {
    return false;
  }

  // Trusted first-party custom scheme (RFC-0016 §4.4/§14) — exact string
  // match only. Must run before the http(s)-only guard below, since this
  // is the sole path that admits a non-http(s) scheme.
  if (client.trusted && client.firstParty && client.redirectUris.includes(requestedUri)) {
    return true;
  }

  // Only http(s) callbacks. (Loopback CLI callbacks are http.)
  if (requested.protocol !== 'http:' && requested.protocol !== 'https:') {
    return false;
  }

  if (isLoopbackHost(requested.hostname)) {
    // Loopback: any registered loopback host of the same hostname matches,
    // ignoring the (ephemeral) port. Path must still match if registered,
    // but the seeded crowi-cli registers bare hosts so any path on the
    // loopback host is accepted.
    return client.redirectUris.some((registered) => {
      try {
        const reg = new URL(registered);
        return isLoopbackHost(reg.hostname) && reg.hostname === requested.hostname && reg.protocol === requested.protocol;
      } catch {
        return false;
      }
    });
  }

  // Non-loopback: exact string match against a registered URI.
  return client.redirectUris.includes(requestedUri);
}
