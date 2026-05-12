import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'enc:v1:';
const KEY_BYTES = 32;
const IV_BYTES = 12;

/**
 * Provides the master key used to encrypt / decrypt sensitive values at rest.
 * Default implementation reads `CROWI_ENCRYPTION_KEY` (base64-encoded 32 bytes).
 * Phase 3 will add KMS-backed providers (AWS / GCP) using the same interface.
 */
export interface KeyProvider {
  /** Throws when the key is not configured or malformed. */
  getKey(): Buffer;
}

class EnvKeyProvider implements KeyProvider {
  private cachedKey: Buffer | null = null;

  getKey(): Buffer {
    if (this.cachedKey) return this.cachedKey;
    const raw = process.env.CROWI_ENCRYPTION_KEY;
    if (!raw) {
      throw new Error('CROWI_ENCRYPTION_KEY is not configured. Generate one with `openssl rand -base64 32`.');
    }
    const buf = Buffer.from(raw, 'base64');
    if (buf.length !== KEY_BYTES) {
      throw new Error(`CROWI_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${buf.length})`);
    }
    this.cachedKey = buf;
    return buf;
  }
}

let keyProvider: KeyProvider = new EnvKeyProvider();

/** Swap the active key provider. Test-only or for Phase 3 KMS plumbing. */
export function setKeyProvider(provider: KeyProvider): void {
  keyProvider = provider;
}

/** Reset to the default env-based provider. Test helper. */
export function resetKeyProvider(): void {
  keyProvider = new EnvKeyProvider();
}

/**
 * Whether the current provider can produce a usable key. Service-layer code
 * should treat encryption as best-effort: if false, fall back to plaintext
 * (= legacy behaviour) so a missing key never crashes the app.
 */
export function isEncryptionConfigured(): boolean {
  try {
    keyProvider.getKey();
    return true;
  } catch {
    return false;
  }
}

/** True when the value carries our envelope prefix. */
export function isEncrypted(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * Encrypt a UTF-8 string with AES-256-GCM. Format:
 *   enc:v1:<base64(iv)>:<base64(authTag)>:<base64(ciphertext)>
 * IV is regenerated per call so the same plaintext yields different ciphertexts
 * (= non-deterministic, not suitable for equality lookups).
 */
export function encrypt(plain: string): string {
  if (typeof plain !== 'string') {
    throw new TypeError('encrypt() expects a string');
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, keyProvider.getKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/**
 * Decrypt a value produced by `encrypt()`. Values without the `enc:v1:` prefix
 * are returned untouched so legacy plaintext rows keep working until they are
 * migrated by the admin re-encryption flow.
 *
 * Throws on tag/IV mismatch (= tampering or wrong key) so callers can distinguish
 * a real auth failure from a legacy passthrough.
 */
export function decrypt(value: string): string {
  if (!isEncrypted(value)) {
    return value;
  }
  const body = value.slice(PREFIX.length);
  const parts = body.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted value: expected enc:v1:<iv>:<tag>:<ct>');
  }
  const [ivB64, tagB64, ctB64] = parts;
  const decipher = crypto.createDecipheriv(ALGORITHM, keyProvider.getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
  return pt.toString('utf8');
}

/** Generate a fresh 32-byte master key, base64-encoded. CLI helper. */
export function generateKey(): string {
  return crypto.randomBytes(KEY_BYTES).toString('base64');
}
