import { isRedirectUriAllowed } from 'src/util/oauth-redirect-uri';

/**
 * RFC-0010 §Security — redirect_uri validation (loopback any-port, exact
 * match otherwise, scheme guard).
 */
describe('isRedirectUriAllowed', () => {
  const loopbackClient = { redirectUris: ['http://127.0.0.1', 'http://localhost'] };
  const webClient = { redirectUris: ['https://app.example/callback'] };

  it('allows a registered loopback host on any port', () => {
    expect(isRedirectUriAllowed(loopbackClient, 'http://127.0.0.1:51234/cb')).toBe(true);
    expect(isRedirectUriAllowed(loopbackClient, 'http://localhost:8080/done')).toBe(true);
    expect(isRedirectUriAllowed(loopbackClient, 'http://127.0.0.1/cb')).toBe(true);
  });

  it('rejects a loopback host not registered by the client', () => {
    expect(isRedirectUriAllowed({ redirectUris: ['http://localhost'] }, 'http://127.0.0.1:9000/cb')).toBe(false);
  });

  it('requires an exact match for non-loopback URIs', () => {
    expect(isRedirectUriAllowed(webClient, 'https://app.example/callback')).toBe(true);
    expect(isRedirectUriAllowed(webClient, 'https://app.example/callback?x=1')).toBe(false);
    expect(isRedirectUriAllowed(webClient, 'https://evil.example/callback')).toBe(false);
  });

  it('rejects non-http(s) schemes', () => {
    expect(isRedirectUriAllowed(loopbackClient, 'ftp://127.0.0.1/cb')).toBe(false);
    expect(isRedirectUriAllowed(loopbackClient, 'javascript:alert(1)')).toBe(false);
  });

  it('rejects an unparseable URI', () => {
    expect(isRedirectUriAllowed(loopbackClient, 'not a url')).toBe(false);
  });
});
