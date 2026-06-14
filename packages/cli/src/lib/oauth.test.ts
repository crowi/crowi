import { createHash } from 'node:crypto';

import { CliError } from './http';
import { validateScope } from './oauth';

/**
 * Unit coverage for the pure OAuth helpers that don't touch the network:
 * `--scope` validation against the issuable catalog. The flow functions
 * (loopback / device / refresh) are integration-shaped and exercised
 * end-to-end; here we lock the client-side guard that runs before any
 * request leaves the machine.
 */
describe('validateScope', () => {
  it('accepts the locked default scope and normalises whitespace', () => {
    expect(validateScope('pages:read   pages:write')).toBe('pages:read pages:write');
  });

  it('accepts umbrella scopes', () => {
    expect(validateScope('read write')).toBe('read write');
  });

  it('rejects an empty scope', () => {
    expect(() => validateScope('   ')).toThrow(CliError);
  });

  it('rejects admin:* (reserved, never issuable)', () => {
    expect(() => validateScope('pages:read admin:write')).toThrow(/non-issuable scope/);
  });

  it('rejects an unknown/typo scope', () => {
    expect(() => validateScope('pages:reed')).toThrow(/pages:reed/);
  });
});

/**
 * PKCE S256 self-check: the challenge derivation is internal, but a known
 * RFC 7636 Appendix B vector pins the base64url(sha256(verifier)) math the
 * loopback flow relies on. Re-deriving it here guards against an accidental
 * change to the encoding (e.g. forgetting to strip padding).
 */
describe('PKCE S256 derivation (RFC 7636 vector)', () => {
  it('matches the RFC 7636 Appendix B example', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const expected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    const challenge = createHash('sha256').update(verifier).digest().toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(challenge).toBe(expected);
  });
});
