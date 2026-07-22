import { ISSUABLE_SCOPES } from '@crowi/api-contract';
import Debug from 'debug';

import type Crowi from 'src/crowi';

const debug = Debug('crowi:util:oauth-client-seed');

/**
 * RFC-0010 Phase 3 — seed the first-party `crowi-cli` OAuth client.
 * RFC-0016 Phase 0 — seed the first-party, **trusted** `crowi-ios` OAuth
 * client alongside it.
 *
 * Idempotent boot step (PHASE3-Q2): `$setOnInsert` only writes on the very
 * first run, so re-running boot — or upgrading an instance that already
 * has the row — never clobbers an operator's later edits to the client.
 * Modelled on the other boot-time init steps (it runs alongside the
 * migration framework's `runBootMigrations`, but stays framework-external
 * per RFC-0008 §12.6 — OAuth client seeding is a seed, not a migration).
 *
 * `crowi-cli` is a **public** client (no secret, PKCE-only). Its
 * `redirectUris` list the loopback hosts; the per-login ephemeral port is
 * matched at request time by `util/oauth-redirect-uri.ts`. It may request
 * any issuable scope (catalog minus `admin:*`).
 *
 * `crowi-ios` is also public/PKCE-only, but is `trusted: true`
 * (RFC-0016 §4.4/§14): its single `redirectUris` entry is the exact
 * custom-scheme callback the iOS app uses, which `util/oauth-redirect-uri.ts`
 * only accepts for a client that is both trusted and first-party, and its
 * `trusted` flag lets the web authorize page skip the consent screen
 * (`hono/handlers/oauth.ts` / the `/oauth/authorize` web page). It shares
 * the same issuable-scope catalog as `crowi-cli`.
 */
const CROWI_CLI_CLIENT_ID = 'crowi-cli';
const CROWI_IOS_CLIENT_ID = 'crowi-ios';

interface OAuthClientSeedSpec {
  clientId: string;
  name: string;
  redirectUris: string[];
  trusted: boolean;
}

const SEED_SPECS: readonly OAuthClientSeedSpec[] = [
  { clientId: CROWI_CLI_CLIENT_ID, name: 'Crowi CLI', redirectUris: ['http://127.0.0.1', 'http://localhost'], trusted: false },
  { clientId: CROWI_IOS_CLIENT_ID, name: 'Crowi for iOS', redirectUris: ['crowi-ios://callback'], trusted: true },
];

export async function runOAuthClientSeed(crowi: Crowi): Promise<void> {
  const OAuthClient = crowi.model('OAuthClient');

  for (const spec of SEED_SPECS) {
    const result = await OAuthClient.updateOne(
      { clientId: spec.clientId },
      {
        $setOnInsert: {
          clientId: spec.clientId,
          name: spec.name,
          type: 'public',
          secretHash: null,
          redirectUris: spec.redirectUris,
          allowedScopes: [...ISSUABLE_SCOPES],
          firstParty: true,
          trusted: spec.trusted,
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );

    if ((result as { upsertedCount?: number }).upsertedCount) {
      console.log(`[crowi] Seeded first-party OAuth client '${spec.clientId}'.`);
    } else {
      debug(`${spec.clientId} client already present — nothing to seed`);
    }
  }
}
