import { Types } from 'mongoose';
import { PAGE_HISTORY_EVENT_KINDS, PAGE_HISTORY_EVENT_SOURCES } from 'src/models/page-history-event';
import { crowi } from 'src/test/setup';

/**
 * feature-page-history-phase1-model (RFC-0021 Phase 1) — `PageHistoryEvent`
 * schema, indexes, and per-kind payload validation. No writer produces one
 * of these yet (that's Phase 2's command cutover) — this suite exercises
 * the model directly, the way `service/page-history/materialize.ts` and
 * `repair.ts` will.
 */

const isE11000 = (err: unknown): boolean => typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;

describe('PageHistoryEvent (RFC-0021 §5.1/§5.2/§5.3, feature-page-history-phase1-model)', () => {
  let PageHistoryEvent;

  const baseEnvelope = () => ({
    page: new Types.ObjectId(),
    actor: null,
    occurredAt: new Date(),
    source: 'web' as const,
  });

  beforeAll(async () => {
    PageHistoryEvent = crowi.model('PageHistoryEvent');
    // `syncIndexes()` blocks until index creation is acked by mongod —
    // mongoose's autoIndex fire-and-forgets (see `user-identity.test.ts`
    // for the same precedent).
    await PageHistoryEvent.syncIndexes();
  });

  afterEach(async () => {
    await PageHistoryEvent.deleteMany({});
  });

  describe('AC-2b — envelope shape', () => {
    test('kind is exactly the 6 page-scoped kinds — no hard-delete kind exists here', () => {
      expect(PAGE_HISTORY_EVENT_KINDS).toEqual(['page_created', 'page_renamed', 'visibility_changed', 'page_trashed', 'page_restored', 'draft_published']);
      expect(PAGE_HISTORY_EVENT_KINDS).not.toContain('page_deleted');
      expect(PAGE_HISTORY_EVENT_KINDS).not.toContain('hard_deleted');
    });

    test('source is the 5 documented origins', () => {
      expect(PAGE_HISTORY_EVENT_SOURCES).toEqual(['web', 'oauth', 'pat', 'collab', 'system']);
    });

    test('the envelope has no scope discriminator and no expiresAt / retention field — hard delete lives in a separate collection (RFC §5.6)', () => {
      const paths = Object.keys(PageHistoryEvent.schema.paths);
      expect(paths).not.toContain('scope');
      expect(paths).not.toContain('expiresAt');
    });
  });

  describe('AC-1 — index uniqueness', () => {
    test('rejects a second event with the same {page, sequence}', async () => {
      const page = new Types.ObjectId();
      await PageHistoryEvent.create({
        ...baseEnvelope(),
        page,
        sequence: 1,
        kind: 'page_created',
        operationId: 'op-a',
        payload: { path: '/a', grant: 1, status: 'published' },
      });

      await expect(
        PageHistoryEvent.create({
          ...baseEnvelope(),
          page,
          sequence: 1,
          kind: 'page_renamed',
          operationId: 'op-b',
          payload: { fromPath: '/a', toPath: '/b', redirectCreated: true, subtree: false },
        }),
      ).rejects.toMatchObject({ code: 11000 });
    });

    test('rejects a second event with the same {page, operationId, kind}', async () => {
      const page = new Types.ObjectId();
      await PageHistoryEvent.create({
        ...baseEnvelope(),
        page,
        sequence: 1,
        kind: 'page_created',
        operationId: 'shared-op',
        payload: { path: '/a', grant: 1, status: 'published' },
      });

      await expect(
        PageHistoryEvent.create({
          ...baseEnvelope(),
          page,
          sequence: 2,
          kind: 'page_created',
          operationId: 'shared-op',
          payload: { path: '/a', grant: 1, status: 'published' },
        }),
      ).rejects.toMatchObject({ code: 11000 });
    });

    test('allows the same {page, operationId} to appear under two different kinds (body-plus-grant, one operationId, two rows)', async () => {
      const page = new Types.ObjectId();
      await expect(
        PageHistoryEvent.create({
          ...baseEnvelope(),
          page,
          sequence: 1,
          kind: 'page_created',
          operationId: 'shared-op-2',
          payload: { path: '/a', grant: 1, status: 'published' },
        }),
      ).resolves.toBeDefined();

      await expect(
        PageHistoryEvent.create({
          ...baseEnvelope(),
          page,
          sequence: 2,
          kind: 'visibility_changed',
          operationId: 'shared-op-2',
          payload: { fromGrant: 1, toGrant: 2 },
        }),
      ).resolves.toBeDefined();
    });

    test('isE11000-style duplicate key surfaces the mongo driver error code', async () => {
      const page = new Types.ObjectId();
      await PageHistoryEvent.create({
        ...baseEnvelope(),
        page,
        sequence: 5,
        kind: 'page_created',
        operationId: 'probe-op',
        payload: { path: '/probe', grant: 1, status: 'published' },
      });
      try {
        await PageHistoryEvent.create({
          ...baseEnvelope(),
          page,
          sequence: 5,
          kind: 'page_restored',
          operationId: 'probe-op-2',
          payload: { fromPath: '/trash/probe', toPath: '/probe' },
        });
        throw new Error('expected a duplicate-key error');
      } catch (err) {
        expect(isE11000(err)).toBe(true);
      }
    });
  });

  describe('AC-2 — payload minimization (visibility_changed excludes grantedUsers/user id/share token/email)', () => {
    test('a visibility_changed payload carrying any forbidden field is REJECTED by the schema (strict: "throw"), not silently stripped', async () => {
      const page = new Types.ObjectId();
      const forbiddenFieldCases: Array<Record<string, unknown>> = [
        { grantedUsers: [new Types.ObjectId()] },
        { userId: new Types.ObjectId() },
        { shareToken: 'tok_abc123' },
        { email: 'someone@example.com' },
      ];

      for (const [i, forbiddenField] of forbiddenFieldCases.entries()) {
        await expect(
          PageHistoryEvent.create({
            ...baseEnvelope(),
            page,
            sequence: i + 1,
            kind: 'visibility_changed',
            operationId: `op-forbidden-${i}`,
            payload: { fromGrant: 1, toGrant: 2, ...forbiddenField },
          }),
        ).rejects.toThrow();
      }

      // A payload with ONLY the legitimate fields is unaffected.
      const doc = await PageHistoryEvent.create({
        ...baseEnvelope(),
        page,
        sequence: 100,
        kind: 'visibility_changed',
        operationId: 'op-allowed',
        payload: { fromGrant: 1, toGrant: 2 },
      });
      const reloaded = await PageHistoryEvent.findById(doc._id).lean().exec();
      expect(Object.keys(reloaded.payload).sort()).toEqual(['fromGrant', 'toGrant']);
    });
  });

  describe('grant fields are validated against the known GRANT_* values (GRANTS, models/page-grants.ts)', () => {
    test('rejects an out-of-range grant on a page_created payload', async () => {
      await expect(
        PageHistoryEvent.create({
          ...baseEnvelope(),
          page: new Types.ObjectId(),
          sequence: 1,
          kind: 'page_created',
          operationId: 'op-invalid-grant',
          payload: { path: '/a', grant: 99, status: 'published' },
        }),
      ).rejects.toThrow();
    });

    test('rejects an out-of-range fromGrant/toGrant on a visibility_changed payload', async () => {
      await expect(
        PageHistoryEvent.create({
          ...baseEnvelope(),
          page: new Types.ObjectId(),
          sequence: 1,
          kind: 'visibility_changed',
          operationId: 'op-invalid-visibility-grant',
          payload: { fromGrant: 1, toGrant: 0 },
        }),
      ).rejects.toThrow();
    });
  });

  describe('kind-scoped payload validation (per-kind schema, not Mixed)', () => {
    test('rejects a payload missing a field required by its kind', async () => {
      await expect(
        PageHistoryEvent.create({
          ...baseEnvelope(),
          page: new Types.ObjectId(),
          sequence: 1,
          kind: 'page_created',
          operationId: 'op-missing',
          payload: { path: '/a', grant: 1 }, // missing `status`
        }),
      ).rejects.toThrow();
    });

    test('rejects a payload carrying a field that belongs to a DIFFERENT kind (cross-kind leakage)', async () => {
      await expect(
        PageHistoryEvent.create({
          ...baseEnvelope(),
          page: new Types.ObjectId(),
          sequence: 1,
          kind: 'page_created',
          operationId: 'op-cross-kind',
          // `fromGrant`/`toGrant` belong to visibility_changed, not page_created.
          payload: { path: '/a', grant: 1, status: 'published', fromGrant: 1, toGrant: 2 },
        }),
      ).rejects.toThrow();
    });

    test('accepts each kind with exactly its own required fields', async () => {
      const page = new Types.ObjectId();
      const cases: Array<{ kind: (typeof PAGE_HISTORY_EVENT_KINDS)[number]; payload: Record<string, unknown> }> = [
        { kind: 'page_created', payload: { path: '/x', grant: 1, status: 'published' } },
        { kind: 'page_renamed', payload: { fromPath: '/x', toPath: '/y', redirectCreated: true, subtree: false } },
        { kind: 'visibility_changed', payload: { fromGrant: 1, toGrant: 2 } },
        { kind: 'page_trashed', payload: { fromPath: '/x', toPath: '/trash/x' } },
        { kind: 'page_restored', payload: { fromPath: '/trash/x', toPath: '/x' } },
        { kind: 'draft_published', payload: { fromStatus: 'draft', toStatus: 'published' } },
      ];

      for (const [i, { kind, payload }] of cases.entries()) {
        await expect(PageHistoryEvent.create({ ...baseEnvelope(), page, sequence: i + 1, kind, operationId: `op-kind-${i}`, payload })).resolves.toMatchObject({
          kind,
        });
      }
    });

    test('rejects an unknown kind', async () => {
      await expect(
        PageHistoryEvent.create({
          ...baseEnvelope(),
          page: new Types.ObjectId(),
          sequence: 1,
          kind: 'page_deleted',
          operationId: 'op-unknown-kind',
          payload: { path: '/x' },
        }),
      ).rejects.toThrow();
    });
  });
});
