import crypto from 'node:crypto';

import {
  ARTIFACT_TOKEN_HKDF_INFO,
  ARTIFACT_TOKEN_TTL_SECONDS,
  type ArtifactTokenPayload,
  artifactDownloadFilename,
  deriveArtifactTokenKey,
  mintArtifactToken,
  resolveArtifactTokenKey,
  verifyArtifactToken,
} from './delivery';

const EXPECTED = { pageId: '507f1f77bcf86cd799439011', revisionId: '507f191e810c19729de860ea' } as const;

const buildPayload = (overrides?: Partial<ArtifactTokenPayload>): ArtifactTokenPayload => ({
  p: EXPECTED.pageId,
  r: EXPECTED.revisionId,
  u: '507f1f77bcf86cd799439099',
  e: Date.now() + ARTIFACT_TOKEN_TTL_SECONDS * 1000,
  ...overrides,
});

describe('artifact delivery token', () => {
  const key = deriveArtifactTokenKey('a-real-secret-value-for-delivery-tests');

  describe('mintArtifactToken / verifyArtifactToken', () => {
    it('round-trips: a freshly minted token verifies to the same payload', () => {
      const payload = buildPayload();
      const token = mintArtifactToken(key, payload);
      expect(verifyArtifactToken(key, token, EXPECTED, Date.now())).toEqual(payload);
    });

    it('rejects an expired token (now >= e)', () => {
      const payload = buildPayload({ e: Date.now() - 1 });
      const token = mintArtifactToken(key, payload);
      expect(verifyArtifactToken(key, token, EXPECTED, Date.now())).toBeNull();
    });

    it('accepts a token at the exact instant before expiry and rejects at/after it', () => {
      const now = Date.now();
      const payload = buildPayload({ e: now + 1 });
      const token = mintArtifactToken(key, payload);
      expect(verifyArtifactToken(key, token, EXPECTED, now)).toEqual(payload);
      expect(verifyArtifactToken(key, token, EXPECTED, now + 1)).toBeNull();
    });

    it('rejects a revisionId mismatch', () => {
      const token = mintArtifactToken(key, buildPayload());
      expect(verifyArtifactToken(key, token, { ...EXPECTED, revisionId: '507f191e810c19729de860eb' }, Date.now())).toBeNull();
    });

    it('rejects a pageId mismatch', () => {
      const token = mintArtifactToken(key, buildPayload());
      expect(verifyArtifactToken(key, token, { ...EXPECTED, pageId: '507f1f77bcf86cd799439012' }, Date.now())).toBeNull();
    });

    it('rejects a 1-byte tampered payload segment', () => {
      const token = mintArtifactToken(key, buildPayload());
      const [payloadPart, mac] = token.split('.');
      const tampered = payloadPart.slice(0, -1) + (payloadPart.at(-1) === 'A' ? 'B' : 'A');
      expect(verifyArtifactToken(key, `${tampered}.${mac}`, EXPECTED, Date.now())).toBeNull();
    });

    it('rejects a 1-byte tampered MAC segment', () => {
      const token = mintArtifactToken(key, buildPayload());
      const [payloadPart, mac] = token.split('.');
      const tampered = mac.slice(0, -1) + (mac.at(-1) === 'A' ? 'B' : 'A');
      expect(verifyArtifactToken(key, `${payloadPart}.${tampered}`, EXPECTED, Date.now())).toBeNull();
    });

    it('rejects a string with zero dots', () => {
      expect(verifyArtifactToken(key, 'not-a-token-at-all', EXPECTED, Date.now())).toBeNull();
    });

    it('rejects a string with 2 dots', () => {
      const token = mintArtifactToken(key, buildPayload());
      expect(verifyArtifactToken(key, `${token}.extra`, EXPECTED, Date.now())).toBeNull();
    });

    it('rejects a payload segment containing non-base64url characters', () => {
      const token = mintArtifactToken(key, buildPayload());
      const [, mac] = token.split('.');
      expect(verifyArtifactToken(key, `not+valid/base64=.${mac}`, EXPECTED, Date.now())).toBeNull();
    });

    it('rejects a MAC segment containing non-base64url characters', () => {
      const token = mintArtifactToken(key, buildPayload());
      const [payloadPart] = token.split('.');
      expect(verifyArtifactToken(key, `${payloadPart}.not+valid/base64=`, EXPECTED, Date.now())).toBeNull();
    });

    /**
     * `mintArtifactToken`'s own type signature can't construct a malformed
     * payload (an extra field, or a `u` value containing a byte sequence no
     * JS string can hold), so these 2 tests sign raw bytes directly — with
     * the same HMAC construction `mintArtifactToken` uses — to prove the
     * shape/decoding checks themselves, not just well-behaved callers,
     * reject them.
     */
    const signRawPayload = (rawBytes: Buffer): string => {
      const payloadPart = rawBytes.toString('base64url');
      const mac = crypto.createHmac('sha256', key).update(payloadPart).digest('base64url');
      return `${payloadPart}.${mac}`;
    };

    it('mintArtifactToken serializes exactly the 4 canonical fields, even when the caller passes a structurally-wider object', () => {
      const payload = buildPayload();
      const withExtra = { ...payload, extra: 'must-not-be-serialized' } as ArtifactTokenPayload;
      const token = mintArtifactToken(key, withExtra);
      const [payloadPart] = token.split('.');
      const decoded = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
      expect(Object.keys(decoded).sort()).toEqual(['e', 'p', 'r', 'u']);
      expect(decoded).not.toHaveProperty('extra');
      // Round-trips normally — if mintArtifactToken had serialized `extra`,
      // verifyArtifactToken's own shape check would reject it (see the
      // sibling test below) and this would be null instead.
      expect(verifyArtifactToken(key, token, EXPECTED, Date.now())).toEqual(payload);
    });

    it('rejects an otherwise-valid, correctly-signed payload carrying an extra field', () => {
      const payload = buildPayload();
      const token = signRawPayload(Buffer.from(JSON.stringify({ ...payload, extra: 'smuggled' })));
      expect(verifyArtifactToken(key, token, EXPECTED, Date.now())).toBeNull();
      // Sanity: the same 4 fields alone (no `extra`) verify fine with the same signing helper.
      expect(verifyArtifactToken(key, signRawPayload(Buffer.from(JSON.stringify(payload))), EXPECTED, Date.now())).toEqual(payload);
    });

    it('rejects a correctly-signed payload whose u field contains invalid UTF-8, rather than silently substituting U+FFFD and verifying anyway', () => {
      // `u` is carried but never compared at verify time, so it is
      // the one field a naive non-fatal UTF-8 decode could smuggle corrupted
      // bytes through without ever failing `p`/`r`/`e` comparison: a lone
      // continuation byte (0x80) decodes to U+FFFD under `Buffer#toString`,
      // which is a perfectly valid JSON string character, so `JSON.parse`
      // and the shape check both still succeed unless decoding is fatal.
      const payload = buildPayload();
      const prefix = Buffer.from(`{"p":"${payload.p}","r":"${payload.r}","u":"`, 'utf8');
      const corruptedByte = Buffer.from([0x80]);
      const suffix = Buffer.from(`","e":${payload.e}}`, 'utf8');
      const rawBytes = Buffer.concat([prefix, corruptedByte, suffix]);
      expect(verifyArtifactToken(key, signRawPayload(rawBytes), EXPECTED, Date.now())).toBeNull();
    });

    it('rejects a correctly-signed payload prefixed with a UTF-8 BOM (fatal decoding must not strip it and let JSON.parse through)', () => {
      // `TextDecoder`'s default `ignoreBOM: false` consumes a leading BOM,
      // which would make `JSON.parse` see clean JSON and verify a payload
      // `Buffer#toString('utf8')` (which keeps a leading U+FEFF) rejected —
      // widening what verifies instead of narrowing it. `ignoreBOM: true`
      // keeps the BOM in the decoded string so this still fails `JSON.parse`.
      const payload = buildPayload();
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      const rawBytes = Buffer.concat([bom, Buffer.from(JSON.stringify(payload))]);
      expect(verifyArtifactToken(key, signRawPayload(rawBytes), EXPECTED, Date.now())).toBeNull();
    });

    it('depends on the HKDF info string: a key derived with a different info never verifies', () => {
      // Built once and reused below — `buildPayload()` embeds `Date.now()`,
      // so calling it a second time for the sanity check could straddle a
      // millisecond boundary and compare against a different `e`.
      const payload = buildPayload();
      const otherInfoKey = Buffer.from(crypto.hkdfSync('sha256', 'a-real-secret-value-for-delivery-tests', Buffer.alloc(0), 'crowi:oauth-state-hmac:v1', 32));
      const token = mintArtifactToken(otherInfoKey, payload);
      expect(verifyArtifactToken(key, token, EXPECTED, Date.now())).toBeNull();
      // Sanity: the same token DOES verify against the key it was actually minted with.
      expect(verifyArtifactToken(otherInfoKey, token, EXPECTED, Date.now())).toEqual(payload);
    });

    it('ARTIFACT_TOKEN_HKDF_INFO is a fixed, non-empty string distinct from the oauth-state info', () => {
      expect(ARTIFACT_TOKEN_HKDF_INFO).toBe('crowi:artifact-delivery-hmac:v1');
      expect(ARTIFACT_TOKEN_HKDF_INFO).not.toBe('crowi:oauth-state-hmac:v1');
    });
  });

  describe('resolveArtifactTokenKey', () => {
    const crowiWithSecrets = (crowiNamespace: Record<string, unknown>) => ({
      getConfig: () => ({ crowi: crowiNamespace }),
    });

    it('returns null when both app:secret and SECRET_TOKEN are unset', () => {
      expect(resolveArtifactTokenKey(crowiWithSecrets({}))).toBeNull();
    });

    it('returns null when the resolved secret is the development default', () => {
      expect(resolveArtifactTokenKey(crowiWithSecrets({ 'app:secret': 'your-secret-key' }))).toBeNull();
    });

    it('derives a key from app:secret when set to a non-default value', () => {
      const result = resolveArtifactTokenKey(crowiWithSecrets({ 'app:secret': 'a-real-secret-value' }));
      expect(result).toEqual(deriveArtifactTokenKey('a-real-secret-value'));
    });

    it('falls back to SECRET_TOKEN when app:secret is unset', () => {
      const result = resolveArtifactTokenKey(crowiWithSecrets({ SECRET_TOKEN: 'a-real-secret-token-value' }));
      expect(result).toEqual(deriveArtifactTokenKey('a-real-secret-token-value'));
    });

    it('does not throw for any of the 4 combinations', () => {
      expect(() => resolveArtifactTokenKey(crowiWithSecrets({}))).not.toThrow();
      expect(() => resolveArtifactTokenKey(crowiWithSecrets({ 'app:secret': 'your-secret-key' }))).not.toThrow();
      expect(() => resolveArtifactTokenKey(crowiWithSecrets({ 'app:secret': 'x' }))).not.toThrow();
      expect(() => resolveArtifactTokenKey(crowiWithSecrets({ SECRET_TOKEN: 'x' }))).not.toThrow();
    });
  });

  describe('artifactDownloadFilename', () => {
    it('uses the last path segment', () => {
      expect(artifactDownloadFilename('/foo/bar')).toBe('bar.html');
    });

    it('falls back to "artifact" for a portal (trailing-slash) path', () => {
      expect(artifactDownloadFilename('/foo/')).toBe('artifact.html');
    });

    it('falls back to "artifact" for the root path', () => {
      expect(artifactDownloadFilename('/')).toBe('artifact.html');
    });
  });
});
