import { crowi } from 'src/test/setup';
import type { OAuthClientModel } from 'src/models/oauth-client';

/**
 * RFC-0010 Phase 3 — OAuthClient unit tests.
 */
describe('OAuthClient', () => {
  let OAuthClient: OAuthClientModel;

  beforeAll(() => {
    OAuthClient = crowi.model('OAuthClient');
  });

  beforeEach(async () => {
    await OAuthClient.deleteMany({});
  });

  it('persists a public client and finds it by clientId', async () => {
    await OAuthClient.create({
      clientId: 'test-cli',
      name: 'Test CLI',
      type: 'public',
      secretHash: null,
      redirectUris: ['http://127.0.0.1', 'http://localhost'],
      allowedScopes: ['pages:read', 'pages:write'],
      firstParty: true,
      trusted: false,
    });

    const found = await OAuthClient.findByClientId('test-cli');
    expect(found).not.toBeNull();
    expect(found?.type).toBe('public');
    expect(found?.secretHash).toBeNull();
    expect(found?.redirectUris).toEqual(['http://127.0.0.1', 'http://localhost']);
    expect(found?.allowedScopes).toContain('pages:write');
  });

  it('returns null for an unknown clientId', async () => {
    expect(await OAuthClient.findByClientId('nope')).toBeNull();
  });

  it('supports confidential clients with a secretHash', async () => {
    await OAuthClient.create({
      clientId: 'confidential-app',
      name: 'App',
      type: 'confidential',
      secretHash: 'deadbeef',
      redirectUris: ['https://app.example/cb'],
      allowedScopes: ['pages:read'],
      firstParty: false,
      trusted: false,
    });
    const found = await OAuthClient.findByClientId('confidential-app');
    expect(found?.type).toBe('confidential');
    expect(found?.secretHash).toBe('deadbeef');
  });
});
