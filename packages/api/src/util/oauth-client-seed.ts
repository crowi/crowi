import { ISSUABLE_SCOPES } from '@crowi/api-contract';
import Debug from 'debug';

import type Crowi from 'src/crowi';

const debug = Debug('crowi:util:oauth-client-seed');

/**
 * RFC-0010 Phase 3 — seed the first-party `crowi-cli` OAuth client.
 *
 * Idempotent boot step (PHASE3-Q2): `$setOnInsert` only writes on the very
 * first run, so re-running boot — or upgrading an instance that already
 * has the row — never clobbers an operator's later edits to the client.
 * Modelled on the other boot-time migrations (`runPageStatusMigration`).
 *
 * `crowi-cli` is a **public** client (no secret, PKCE-only). Its
 * `redirectUris` list the loopback hosts; the per-login ephemeral port is
 * matched at request time by `util/oauth-redirect-uri.ts`. It may request
 * any issuable scope (catalog minus `admin:*`).
 */
const CROWI_CLI_CLIENT_ID = 'crowi-cli';

export async function runOAuthClientSeed(crowi: Crowi): Promise<void> {
  const OAuthClient = crowi.model('OAuthClient');

  const result = await OAuthClient.updateOne(
    { clientId: CROWI_CLI_CLIENT_ID },
    {
      $setOnInsert: {
        clientId: CROWI_CLI_CLIENT_ID,
        name: 'Crowi CLI',
        type: 'public',
        secretHash: null,
        redirectUris: ['http://127.0.0.1', 'http://localhost'],
        allowedScopes: [...ISSUABLE_SCOPES],
        firstParty: true,
        trusted: false,
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );

  if ((result as { upsertedCount?: number }).upsertedCount) {
    console.log(`[crowi] Seeded first-party OAuth client '${CROWI_CLI_CLIENT_ID}'.`);
  } else {
    debug('crowi-cli client already present — nothing to seed');
  }
}
