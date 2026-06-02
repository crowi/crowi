import crypto from 'node:crypto';

import { verifyPkceS256 } from 'src/util/pkce';

/**
 * RFC 7636 PKCE S256 verification.
 */
describe('verifyPkceS256', () => {
  const makeChallenge = (verifier: string) => crypto.createHash('sha256').update(verifier).digest('base64url');

  it('accepts a matching verifier/challenge pair', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(verifyPkceS256(verifier, makeChallenge(verifier))).toBe(true);
  });

  it('matches the RFC 7636 Appendix B test vector', () => {
    // RFC 7636 §Appendix B: verifier -> challenge.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
  });

  it('rejects a wrong verifier', () => {
    const challenge = makeChallenge('the-real-verifier');
    expect(verifyPkceS256('a-different-verifier', challenge)).toBe(false);
  });

  it('rejects an empty / mismatched-length challenge', () => {
    expect(verifyPkceS256('verifier', '')).toBe(false);
  });
});
