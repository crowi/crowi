import crypto from 'crypto';
import { decrypt, encrypt, generateKey, isEncrypted, isEncryptionConfigured, resetKeyProvider } from 'src/util/crypto';

describe('util/crypto', () => {
  const originalKey = process.env.CROWI_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.CROWI_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
    resetKeyProvider();
  });

  afterAll(() => {
    if (originalKey === undefined) {
      delete process.env.CROWI_ENCRYPTION_KEY;
    } else {
      process.env.CROWI_ENCRYPTION_KEY = originalKey;
    }
    resetKeyProvider();
  });

  test('encrypt + decrypt round-trip', () => {
    const plain = 'hello world — マルチバイト文字も OK 🦉';
    const encrypted = encrypt(plain);

    expect(isEncrypted(encrypted)).toBe(true);
    expect(encrypted.startsWith('enc:v1:')).toBe(true);
    expect(decrypt(encrypted)).toBe(plain);
  });

  test('encrypt produces different ciphertext for the same plaintext (non-deterministic IV)', () => {
    const a = encrypt('same input');
    const b = encrypt('same input');

    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe('same input');
    expect(decrypt(b)).toBe('same input');
  });

  test('isEncrypted only returns true for the prefixed form', () => {
    expect(isEncrypted('enc:v1:foo:bar:baz')).toBe(true);
    expect(isEncrypted('plain string')).toBe(false);
    expect(isEncrypted('')).toBe(false);
    expect(isEncrypted(null)).toBe(false);
    expect(isEncrypted(undefined)).toBe(false);
    expect(isEncrypted(42)).toBe(false);
  });

  test('decrypt passes legacy plaintext through unchanged', () => {
    expect(decrypt('legacy plaintext token')).toBe('legacy plaintext token');
    expect(decrypt('')).toBe('');
  });

  test('decrypt throws when the auth tag is tampered', () => {
    const encrypted = encrypt('secret value');
    // `enc:v1:<iv>:<tag>:<ct>` splits into 5 — the prefix occupies 0 and 1, so
    // the payload starts at index 2. Binding from index 2 lines the names up
    // with the segments; taking the tag from index 2 instead would hand
    // `decrypt` the IV as its auth tag (12 bytes, not 16) and the real tag as
    // the ciphertext, which throws for the wrong reason and never exercises a
    // tag flip at all.
    const [, , ivB64, tagB64, ctB64] = encrypted.split(':');
    const tagBytes = Buffer.from(tagB64, 'base64');
    expect(tagBytes).toHaveLength(16);
    tagBytes[0] ^= 0x01;
    const tampered = `enc:v1:${ivB64}:${tagBytes.toString('base64')}:${ctB64}`;

    expect(() => decrypt(tampered)).toThrow();
  });

  test('decrypt throws on malformed envelope', () => {
    expect(() => decrypt('enc:v1:onlyOnePart')).toThrow(/Malformed/);
    expect(() => decrypt('enc:v1:a:b')).toThrow(/Malformed/);
  });

  test('isEncryptionConfigured reports based on key availability', () => {
    expect(isEncryptionConfigured()).toBe(true);

    delete process.env.CROWI_ENCRYPTION_KEY;
    resetKeyProvider();
    expect(isEncryptionConfigured()).toBe(false);
    expect(() => encrypt('x')).toThrow(/not configured/);
  });

  test('encrypt throws when the key is not 32 bytes', () => {
    process.env.CROWI_ENCRYPTION_KEY = Buffer.alloc(16).toString('base64');
    resetKeyProvider();

    expect(() => encrypt('x')).toThrow(/32 bytes/);
  });

  test('generateKey returns a fresh base64-encoded 32-byte key', () => {
    const a = generateKey();
    const b = generateKey();
    expect(a).not.toBe(b);
    expect(Buffer.from(a, 'base64')).toHaveLength(32);
  });
});
