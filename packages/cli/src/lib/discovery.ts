import { DiscoveryResponseSchema } from '@crowi/api-contract';

import type { ProfileEndpoints } from './config';
import { stripTrailingSlash } from './config';
import { CliError, EXIT } from './http';
import { warn } from './output';

/**
 * RFC 8414 authorization-server metadata discovery.
 *
 * The discovery document lives at the **server root**
 * (`<endpoint>/.well-known/oauth-authorization-server`) — NOT under
 * `/api` — and returns the OAuth endpoint URLs already carrying their
 * correct path prefix:
 *
 *   - `token_endpoint` / `revocation_endpoint` /
 *     `device_authorization_endpoint` already include `/api/oauth/*`.
 *   - `authorization_endpoint` + the device `verification_uri` are **web
 *     pages** on the issuer (server `CLIENT_URL`) origin, NOT API routes.
 *
 * The CLI therefore caches these URLs verbatim into the profile and dials
 * them as-is — never reconstructing the `/api` prefix — so split-origin
 * / reverse-proxy deployments work. This is the single source of the
 * token/revoke/device/authorize URLs.
 */

/** Path of the RFC 8414 discovery document, relative to the server root. */
const DISCOVERY_PATH = '/.well-known/oauth-authorization-server';

/** Loopback hosts where plaintext `http:` discovery is acceptable (dev). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Parse a URL or throw a {@link CliError} pinning which discovery field was
 * malformed (the discovery doc is the trust root for every subsequent dial).
 */
function parseUrl(field: string, value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new CliError(`OAuth discovery document is malformed: "${field}" is not a valid URL (${value})`, {
      exitCode: EXIT.GENERAL,
    });
  }
}

/**
 * Defend against the OAuth metadata mix-up vector: the discovery document is
 * fetched from `endpoint` but then hands back token / device / revocation URLs
 * the CLI dials verbatim. A malicious or misconfigured server could point
 * those at a foreign origin to exfiltrate the code/token. We therefore pin the
 * security-sensitive endpoints to the `issuer` origin.
 *
 * `authorization_endpoint` MAY legitimately live on a different (web) origin —
 * `CLIENT_URL` can be a separate host from the API — so it is NOT constrained
 * here; it only ever receives the browser, never a token. When the issuer
 * scheme is plaintext `http:` on a non-loopback host we warn (warn-only,
 * never block) that the discovery channel is insecure.
 */
function validateOrigins(issuer: URL, endpoints: { token: URL; device?: URL; revoke?: URL }): void {
  const expected = issuer.origin;
  const pin = (field: string, url: URL): void => {
    if (url.origin !== expected) {
      throw new CliError(
        `OAuth discovery rejected: "${field}" (${url.origin}) is not on the issuer origin (${expected}) — ` +
          `the metadata issuer must match the endpoints you are logging into (possible metadata mix-up).`,
        { exitCode: EXIT.GENERAL },
      );
    }
  };

  pin('token_endpoint', endpoints.token);
  if (endpoints.device) pin('device_authorization_endpoint', endpoints.device);
  if (endpoints.revoke) pin('revocation_endpoint', endpoints.revoke);

  if (issuer.protocol === 'http:' && !LOOPBACK_HOSTS.has(issuer.hostname) && !LOOPBACK_HOSTS.has(issuer.host)) {
    warn(`OAuth discovery for ${issuer.origin} uses plaintext http — credentials may be exposed in transit (continuing anyway).`);
  }
}

/**
 * Fetch + parse the discovery document for `endpoint`. Parsed leniently
 * (extra fields tolerated for version skew); the required endpoint URLs are
 * validated to be present. Returns the subset the CLI caches into a profile.
 */
export async function discover(
  endpoint: string,
): Promise<Required<Pick<ProfileEndpoints, 'issuer' | 'tokenEndpoint' | 'revokeEndpoint' | 'authorizeEndpoint'>> & Pick<ProfileEndpoints, 'deviceEndpoint'>> {
  const url = `${stripTrailingSlash(endpoint)}${DISCOVERY_PATH}`;

  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(`could not reach ${url}: ${message}`, { exitCode: EXIT.GENERAL });
  }

  if (!response.ok) {
    throw new CliError(`OAuth discovery failed at ${url} (status ${response.status}) — is this a Crowi 2.0 server?`, {
      exitCode: EXIT.GENERAL,
      status: response.status,
    });
  }

  const body: unknown = await response.json().catch(() => undefined);
  // Lenient parse: tolerate unknown extra fields, only assert the shape of
  // the fields the CLI relies on.
  const parsed = DiscoveryResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new CliError(`OAuth discovery document at ${url} is malformed: ${parsed.error.issues.map((i) => i.message).join('; ')}`, {
      exitCode: EXIT.GENERAL,
    });
  }

  const d = parsed.data;

  // Anchor the trust root to the URL the USER typed, not the (untrusted)
  // issuer the doc claims. `issuer` comes straight from the discovery
  // document; if we only pinned token/device/revoke to `issuer.origin` a
  // self-consistent malicious doc (issuer + every endpoint on a foreign
  // origin) would pass. Requiring `endpoint.origin === issuer.origin` makes
  // the issuer-origin pinning below transitively == the endpoint origin.
  const issuer = parseUrl('issuer', d.issuer);
  const endpointOrigin = new URL(stripTrailingSlash(endpoint)).origin;
  if (endpointOrigin !== issuer.origin) {
    throw new CliError(`discovery issuer ${issuer.origin} does not match the server you are logging into ${endpointOrigin} — possible metadata mix-up`, {
      exitCode: EXIT.GENERAL,
    });
  }

  // Pin the security-sensitive endpoints to the issuer origin before the CLI
  // ever dials them (OAuth metadata mix-up defense).
  const token = parseUrl('token_endpoint', d.token_endpoint);
  const revoke = parseUrl('revocation_endpoint', d.revocation_endpoint);
  const device = d.device_authorization_endpoint ? parseUrl('device_authorization_endpoint', d.device_authorization_endpoint) : undefined;
  validateOrigins(issuer, { token, revoke, device });

  return {
    issuer: d.issuer,
    tokenEndpoint: d.token_endpoint,
    revokeEndpoint: d.revocation_endpoint,
    authorizeEndpoint: d.authorization_endpoint,
    deviceEndpoint: d.device_authorization_endpoint,
  };
}
