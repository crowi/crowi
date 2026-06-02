import { ISSUABLE_SCOPES } from '@crowi/api-contract';

import { crowi } from 'src/test/setup';
import type { OAuthClientModel } from 'src/models/oauth-client';
import { runOAuthClientSeed } from 'src/util/oauth-client-seed';

/**
 * RFC-0010 Phase 3 — crowi-cli seed is idempotent.
 */
describe('runOAuthClientSeed', () => {
  const OAuthClient = () => crowi.model('OAuthClient') as OAuthClientModel;

  beforeEach(async () => {
    await OAuthClient().deleteMany({ clientId: 'crowi-cli' });
  });

  afterAll(async () => {
    await OAuthClient().deleteMany({ clientId: 'crowi-cli' });
  });

  it('seeds the crowi-cli public client with issuable scopes + loopback redirects', async () => {
    await runOAuthClientSeed(crowi);
    const client = await OAuthClient().findByClientId('crowi-cli');
    expect(client).not.toBeNull();
    expect(client?.type).toBe('public');
    expect(client?.secretHash).toBeNull();
    expect(client?.firstParty).toBe(true);
    expect(client?.redirectUris).toEqual(['http://127.0.0.1', 'http://localhost']);
    expect(client?.allowedScopes).toEqual([...ISSUABLE_SCOPES]);
    expect(client?.allowedScopes).not.toContain('admin:read');
  });

  it('is idempotent — a second run leaves exactly one row untouched', async () => {
    await runOAuthClientSeed(crowi);
    const first = await OAuthClient().findByClientId('crowi-cli');
    await runOAuthClientSeed(crowi);
    const count = await OAuthClient().countDocuments({ clientId: 'crowi-cli' });
    const second = await OAuthClient().findByClientId('crowi-cli');
    expect(count).toBe(1);
    expect(second?._id.toString()).toBe(first?._id.toString());
    expect(second?.createdAt.getTime()).toBe(first?.createdAt.getTime());
  });
});
