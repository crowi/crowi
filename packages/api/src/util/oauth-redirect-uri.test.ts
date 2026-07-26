import { isRedirectUriAllowed } from 'src/util/oauth-redirect-uri';

/**
 * RFC-0010 §Security — redirect_uri validation (loopback any-port, exact
 * match otherwise, scheme guard).
 * RFC-0016 §4.4/§14 — trusted first-party custom-scheme exact match.
 */
describe('isRedirectUriAllowed', () => {
  const loopbackClient = { redirectUris: ['http://127.0.0.1', 'http://localhost'], trusted: false, firstParty: true };
  const webClient = { redirectUris: ['https://app.example/callback'], trusted: false, firstParty: false };
  const trustedFirstPartyClient = { redirectUris: ['crowi-ios://callback'], trusted: true, firstParty: true };

  it('allows a registered loopback host on any port', () => {
    expect(isRedirectUriAllowed(loopbackClient, 'http://127.0.0.1:51234/cb')).toBe(true);
    expect(isRedirectUriAllowed(loopbackClient, 'http://localhost:8080/done')).toBe(true);
    expect(isRedirectUriAllowed(loopbackClient, 'http://127.0.0.1/cb')).toBe(true);
  });

  it('rejects a loopback host not registered by the client', () => {
    expect(isRedirectUriAllowed({ redirectUris: ['http://localhost'], trusted: false, firstParty: true }, 'http://127.0.0.1:9000/cb')).toBe(false);
  });

  it('requires an exact match for non-loopback URIs', () => {
    expect(isRedirectUriAllowed(webClient, 'https://app.example/callback')).toBe(true);
    expect(isRedirectUriAllowed(webClient, 'https://app.example/callback?x=1')).toBe(false);
    expect(isRedirectUriAllowed(webClient, 'https://evil.example/callback')).toBe(false);
  });

  it('rejects non-http(s) schemes for a non-trusted client', () => {
    expect(isRedirectUriAllowed(loopbackClient, 'ftp://127.0.0.1/cb')).toBe(false);
    expect(isRedirectUriAllowed(loopbackClient, 'javascript:alert(1)')).toBe(false);
  });

  it('rejects an unparseable URI', () => {
    expect(isRedirectUriAllowed(loopbackClient, 'not a url')).toBe(false);
  });

  it('accepts an exact-match custom scheme for a trusted first-party client', () => {
    expect(isRedirectUriAllowed(trustedFirstPartyClient, 'crowi-ios://callback')).toBe(true);
  });

  it('rejects the same custom-scheme URI for a client that is not both trusted and firstParty', () => {
    expect(isRedirectUriAllowed({ redirectUris: ['crowi-ios://callback'], trusted: false, firstParty: true }, 'crowi-ios://callback')).toBe(false);
    expect(isRedirectUriAllowed({ redirectUris: ['crowi-ios://callback'], trusted: true, firstParty: false }, 'crowi-ios://callback')).toBe(false);
  });

  it('rejects an unregistered scheme even for a trusted first-party client', () => {
    expect(isRedirectUriAllowed(trustedFirstPartyClient, 'javascript:alert(1)')).toBe(false);
  });

  it('rejects a partial match (different path) even for a trusted first-party client', () => {
    expect(isRedirectUriAllowed(trustedFirstPartyClient, 'crowi-ios://callback/extra')).toBe(false);
  });

  it('rejects a different (unregistered) custom scheme for a trusted first-party client', () => {
    expect(isRedirectUriAllowed(trustedFirstPartyClient, 'other-scheme://callback')).toBe(false);
  });
});
