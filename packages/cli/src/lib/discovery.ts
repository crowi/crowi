import { DiscoveryResponseSchema } from '@crowi/api-contract';

import type { ProfileEndpoints } from './config';
import { stripTrailingSlash } from './config';
import { CliError, EXIT } from './http';

/**
 * RFC 8414 authorization-server metadata discovery.
 *
 * The discovery document lives at the **server root**
 * (`<endpoint>/.well-known/oauth-authorization-server`) — NOT under
 * `/api/v2` — and returns the OAuth endpoint URLs already carrying their
 * correct path prefix:
 *
 *   - `token_endpoint` / `revocation_endpoint` /
 *     `device_authorization_endpoint` already include `/api/v2/oauth/*`.
 *   - `authorization_endpoint` + the device `verification_uri` are **web
 *     pages** on the issuer (server `CLIENT_URL`) origin, NOT API routes.
 *
 * The CLI therefore caches these URLs verbatim into the profile and dials
 * them as-is — never reconstructing the `/api/v2` prefix — so split-origin
 * / reverse-proxy deployments work. This is the single source of the
 * token/revoke/device/authorize URLs.
 */

/** Path of the RFC 8414 discovery document, relative to the server root. */
const DISCOVERY_PATH = '/.well-known/oauth-authorization-server';

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
  return {
    issuer: d.issuer,
    tokenEndpoint: d.token_endpoint,
    revokeEndpoint: d.revocation_endpoint,
    authorizeEndpoint: d.authorization_endpoint,
    deviceEndpoint: d.device_authorization_endpoint,
  };
}
