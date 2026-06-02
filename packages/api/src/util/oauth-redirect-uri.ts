import type { OAuthClientDocument } from 'src/models/oauth-client';

/**
 * RFC-0010 §Security — redirect_uri validation for the Auth Code flow.
 *
 * Two rules:
 *
 *  - **Loopback** (`127.0.0.1` / `localhost`, http): allowed if the client
 *    registered a matching loopback host, *regardless of port*. Native /
 *    CLI clients bind an ephemeral loopback port per login (RFC 8252
 *    §7.3), so the port cannot be pre-registered; the host match is the
 *    security boundary.
 *  - **Everything else**: must match one of the client's `redirectUris`
 *    exactly (string equality), preventing open-redirect to an attacker
 *    origin.
 *
 * Anything that does not parse as a URL, or uses a non-http(s) scheme, is
 * rejected.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

export function isRedirectUriAllowed(client: Pick<OAuthClientDocument, 'redirectUris'>, requestedUri: string): boolean {
  let requested: URL;
  try {
    requested = new URL(requestedUri);
  } catch {
    return false;
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
