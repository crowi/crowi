import { completeOperation } from 'src/service/page-history/operation';
import { crowi } from 'src/test/setup';

/**
 * feature-page-history-phase1-model (RFC-0021 §5.3/§5.5a Phase 1) —
 * `PageHistoryOperation` schema and indexes. Not itemized under a numbered
 * AC in the spec (no command writes a row here until Phase 2), but the
 * model's index/validation shape still needs baseline coverage — this
 * mirrors `user-identity.test.ts`'s Phase-0 precedent (a new, as-yet-unused
 * collection whose schema is worth pinning before anything depends on it).
 */

const isE11000 = (err: unknown): boolean => typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;

describe('PageHistoryOperation (RFC-0021 §5.3/§5.5a, feature-page-history-phase1-model)', () => {
  let PageHistoryOperation;

  // Fixed-width (32 chars, always >= the 16-char minimum) so the generator
  // itself can never accidentally violate the length bound it's used to
  // exercise below.
  let keyCounter = 0;
  const validKey = () => `idempotency-key-${String(keyCounter++).padStart(6, '0')}-abcdefgh`;

  beforeAll(async () => {
    PageHistoryOperation = crowi.model('PageHistoryOperation');
    await PageHistoryOperation.syncIndexes();
  });

  afterEach(async () => {
    await PageHistoryOperation.deleteMany({});
  });

  test('persists a minimal record with defaulted lease/result/pageStates', async () => {
    const key = validKey();
    const doc = await PageHistoryOperation.create({
      actor: null,
      command: 'rename',
      idempotencyKey: key,
      operationId: 'op-1',
      requestFingerprint: 'fp-1',
    });

    expect(doc.idempotencyKey).toBe(key);
    expect(doc.lease).toBeNull();
    expect(doc.result).toBeNull();
    expect(doc.expiresAt).toBeNull();
  });

  test('the single-page command input has no schema defaults', async () => {
    // Phase 2c-2's command writes all of these at insert time, and recovery
    // reads them back to rebuild the entering CAS — including whether the Page
    // had a `status` field at all. A default would make "the command never
    // wrote this" indistinguishable from "the command wrote the default",
    // which is precisely the distinction `fromStatusPresent` exists to carry.
    const doc = await PageHistoryOperation.create({
      actor: null,
      command: 'rename',
      idempotencyKey: validKey(),
      operationId: 'op-no-defaults',
      requestFingerprint: 'fp-no-defaults',
    });

    const raw = await PageHistoryOperation.collection.findOne({ _id: doc._id });
    for (const field of ['page', 'fromPath', 'toPath', 'fromStatus', 'fromStatusPresent', 'toStatus', 'createRedirect', 'source']) {
      expect(field in raw).toBe(false);
    }
  });

  describe('Idempotency-Key validation (16-128 URL-safe characters)', () => {
    test.each([
      ['too short', 'a'.repeat(15)],
      ['contains a space', `${'a'.repeat(20)} b`],
      ['contains a slash', `${'a'.repeat(20)}/b`],
      ['over 128 characters', 'a'.repeat(129)],
    ])('rejects %s', async (_label, idempotencyKey) => {
      await expect(
        PageHistoryOperation.create({ actor: null, command: 'rename', idempotencyKey, operationId: `op-${_label}`, requestFingerprint: 'fp' }),
      ).rejects.toThrow();
    });

    test('accepts exactly 16 and exactly 128 URL-safe characters', async () => {
      await expect(
        PageHistoryOperation.create({ actor: null, command: 'rename', idempotencyKey: 'a'.repeat(16), operationId: 'op-min', requestFingerprint: 'fp' }),
      ).resolves.toBeDefined();
      await expect(
        PageHistoryOperation.create({
          actor: null,
          command: 'rename',
          idempotencyKey: `${'a'.repeat(126)}-_`,
          operationId: 'op-max',
          requestFingerprint: 'fp',
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('indexes', () => {
    test('rejects a second record with the same {actor, command, idempotencyKey}', async () => {
      const key = validKey();
      await PageHistoryOperation.create({ actor: null, command: 'rename', idempotencyKey: key, operationId: 'op-a', requestFingerprint: 'fp-a' });
      await expect(
        PageHistoryOperation.create({ actor: null, command: 'rename', idempotencyKey: key, operationId: 'op-b', requestFingerprint: 'fp-b' }),
      ).rejects.toMatchObject({ code: 11000 });
    });

    test('rejects a second record with the same operationId', async () => {
      await PageHistoryOperation.create({
        actor: null,
        command: 'rename',
        idempotencyKey: validKey(),
        operationId: 'shared-operation-id',
        requestFingerprint: 'fp',
      });
      await expect(
        PageHistoryOperation.create({
          actor: null,
          command: 'grant',
          idempotencyKey: validKey(),
          operationId: 'shared-operation-id',
          requestFingerprint: 'fp',
        }),
      ).rejects.toMatchObject({ code: 11000 });
    });

    test('rejects a second record with the same retryTokenNonce, but allows omitting it entirely (sparse)', async () => {
      await PageHistoryOperation.create({
        actor: null,
        command: 'rename',
        idempotencyKey: validKey(),
        operationId: 'op-nonce-a',
        requestFingerprint: 'fp',
        retryTokenNonce: 'nonce-1',
      });
      await expect(
        PageHistoryOperation.create({
          actor: null,
          command: 'rename',
          idempotencyKey: validKey(),
          operationId: 'op-nonce-b',
          requestFingerprint: 'fp',
          retryTokenNonce: 'nonce-1',
        }),
      ).rejects.toMatchObject({ code: 11000 });

      // Two records with NO retryTokenNonce at all must not collide with
      // each other (sparse index — absence is not a duplicate value).
      await expect(
        PageHistoryOperation.create({ actor: null, command: 'rename', idempotencyKey: validKey(), operationId: 'op-no-nonce-a', requestFingerprint: 'fp' }),
      ).resolves.toBeDefined();
      await expect(
        PageHistoryOperation.create({ actor: null, command: 'rename', idempotencyKey: validKey(), operationId: 'op-no-nonce-b', requestFingerprint: 'fp' }),
      ).resolves.toBeDefined();
    });

    test('isE11000-style duplicate key surfaces the mongo driver error code', async () => {
      const key = validKey();
      await PageHistoryOperation.create({ actor: null, command: 'rename', idempotencyKey: key, operationId: 'op-probe', requestFingerprint: 'fp' });
      try {
        await PageHistoryOperation.create({ actor: null, command: 'rename', idempotencyKey: key, operationId: 'op-probe-2', requestFingerprint: 'fp' });
        throw new Error('expected a duplicate-key error');
      } catch (err) {
        expect(isE11000(err)).toBe(true);
      }
    });
  });

  // This collection shipped with `expiresAt` but no TTL index behind it.
  // Wall-clock expiry itself is deliberately not asserted here (Mongo's TTL
  // monitor sweeps on its own ~60s cadence, unreliable to await under a test
  // harness); what's pinned is the declaration and the null-vs-set
  // distinction the index depends on.
  describe('TTL (AC-9, AC-10)', () => {
    test('AC-9: declares a TTL index on expiresAt with expireAfterSeconds: 0', () => {
      const indexes = PageHistoryOperation.schema.indexes();
      const ttlIndex = indexes.find(([fields]) => Object.keys(fields).length === 1 && fields.expiresAt === 1);

      expect(ttlIndex).toBeDefined();
      const [, options] = ttlIndex;
      expect(options.expireAfterSeconds).toBe(0);
    });

    test('AC-10: a freshly-created (in-flight) operation has expiresAt: null — not a TTL match', async () => {
      const doc = await PageHistoryOperation.create({
        actor: null,
        command: 'trash',
        idempotencyKey: validKey(),
        operationId: 'op-ttl-in-flight',
        requestFingerprint: 'fp',
      });

      expect(doc.expiresAt).toBeNull();
    });

    test('AC-9: completeOperation sets expiresAt to a future retention deadline once the operation settles', async () => {
      const before = await PageHistoryOperation.create({
        actor: null,
        command: 'trash',
        idempotencyKey: validKey(),
        operationId: 'op-ttl-settled',
        requestFingerprint: 'fp',
      });
      expect(before.expiresAt).toBeNull();

      const settled = await completeOperation(crowi, 'op-ttl-settled', { status: 'succeeded' });

      expect(settled.expiresAt).not.toBeNull();
      expect(settled.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });
  });
});
