import { ISSUABLE_SCOPES } from '@crowi/api-contract';

import { crowi } from 'src/test/setup';
import type { OAuthClientModel } from 'src/models/oauth-client';
import { runOAuthClientSeed } from 'src/util/oauth-client-seed';

/**
 * RFC-0010 Phase 3 — crowi-cli seed is idempotent.
 * RFC-0016 Phase 0 — crowi-ios seed (trusted first-party) is idempotent and
 * does not disturb crowi-cli.
 */
describe('runOAuthClientSeed', () => {
  const OAuthClient = () => crowi.model('OAuthClient') as OAuthClientModel;

  beforeEach(async () => {
    await OAuthClient().deleteMany({ clientId: { $in: ['crowi-cli', 'crowi-ios'] } });
  });

  afterAll(async () => {
    await OAuthClient().deleteMany({ clientId: { $in: ['crowi-cli', 'crowi-ios'] } });
  });

  it('seeds the crowi-cli public client with issuable scopes + loopback redirects', async () => {
    await runOAuthClientSeed(crowi);
    const client = await OAuthClient().findByClientId('crowi-cli');
    expect(client).not.toBeNull();
    expect(client?.type).toBe('public');
    expect(client?.secretHash).toBeNull();
    expect(client?.firstParty).toBe(true);
    expect(client?.trusted).toBe(false);
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

  it('seeds the crowi-ios public, trusted, first-party client with a custom-scheme redirect', async () => {
    await runOAuthClientSeed(crowi);
    const client = await OAuthClient().findByClientId('crowi-ios');
    expect(client).not.toBeNull();
    expect(client?.type).toBe('public');
    expect(client?.secretHash).toBeNull();
    expect(client?.firstParty).toBe(true);
    expect(client?.trusted).toBe(true);
    expect(client?.redirectUris).toEqual(['crowi-ios://callback']);
    expect(client?.allowedScopes).toEqual([...ISSUABLE_SCOPES]);
    expect(client?.allowedScopes).not.toContain('admin:read');
  });

  it('crowi-ios seed is idempotent and leaves crowi-cli untouched', async () => {
    await runOAuthClientSeed(crowi);
    const cliFirst = await OAuthClient().findByClientId('crowi-cli');
    const iosFirst = await OAuthClient().findByClientId('crowi-ios');

    await runOAuthClientSeed(crowi);

    const cliCount = await OAuthClient().countDocuments({ clientId: 'crowi-cli' });
    const iosCount = await OAuthClient().countDocuments({ clientId: 'crowi-ios' });
    const cliSecond = await OAuthClient().findByClientId('crowi-cli');
    const iosSecond = await OAuthClient().findByClientId('crowi-ios');

    expect(cliCount).toBe(1);
    expect(iosCount).toBe(1);
    expect(cliSecond?._id.toString()).toBe(cliFirst?._id.toString());
    expect(cliSecond?.createdAt.getTime()).toBe(cliFirst?.createdAt.getTime());
    expect(iosSecond?._id.toString()).toBe(iosFirst?._id.toString());
    expect(iosSecond?.createdAt.getTime()).toBe(iosFirst?.createdAt.getTime());
  });
});
