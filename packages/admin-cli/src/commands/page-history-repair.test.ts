import { formatFatalErrorLine, formatRepairReport } from './page-history-repair';

/**
 * feature-page-history-phase1-model (RFC-0021 §6.4/§13.2a, Phase 1, codex
 * review attempt 3) — "operator report truncated ... must preserve details
 * in CLI output; add CLI test to lock report content and exit codes."
 * `formatRepairReport` is the pure summary -> printable-report + exit-code
 * mapping the `page-history repair` action delegates to (mirrors
 * `rebuild.test.ts`'s coverage of `rebuildExitCode` — unit-tested without
 * the boot ceremony).
 */

describe('formatRepairReport', () => {
  it('reports nothing and exits 0 when no scan ran (empty summary)', () => {
    const { lines, exitCode } = formatRepairReport({});
    expect(lines).toEqual([]);
    expect(exitCode).toBe(0);
  });

  describe('outbox', () => {
    it('exits 0 and omits detail sections for a clean run (nothing repaired, nothing failed)', () => {
      const { lines, exitCode } = formatRepairReport({
        outbox: { scannedPages: 0, repairedPageIds: [], failed: [], lastPageId: null },
      });
      expect(exitCode).toBe(0);
      expect(lines).toEqual(['outbox: scanned=0 repaired=0 failed=0 lastPageId=(none)']);
    });

    it('lists every repaired page id', () => {
      const { lines, exitCode } = formatRepairReport({
        outbox: { scannedPages: 2, repairedPageIds: ['page-a', 'page-b'], failed: [], lastPageId: 'page-b' },
      });
      expect(exitCode).toBe(0);
      expect(lines).toEqual(['outbox: scanned=2 repaired=2 failed=0 lastPageId=page-b', '  repaired pages:', '    page-a', '    page-b']);
    });

    it('lists every failure with its page id and reason, and exits 2', () => {
      const { lines, exitCode } = formatRepairReport({
        outbox: {
          scannedPages: 1,
          repairedPageIds: [],
          failed: [{ pageId: 'page-corrupt', reason: 'materializePendingEntry: malformed entry' }],
          lastPageId: 'page-corrupt',
        },
      });
      expect(exitCode).toBe(2);
      expect(lines).toContain('  outbox failures (needs manual investigation):');
      expect(lines).toContain('    page page-corrupt: materializePendingEntry: malformed entry');
    });

    it('includes the revision id and sequence a failed outbox entry named, when present', () => {
      const { lines } = formatRepairReport({
        outbox: {
          scannedPages: 1,
          repairedPageIds: [],
          failed: [
            {
              pageId: 'page-corrupt',
              revisionId: 'rev-corrupt',
              sequence: 7,
              reason: 'materializePendingEntry: revision rev-corrupt historySequence mismatch',
            },
          ],
          lastPageId: 'page-corrupt',
        },
      });
      expect(lines).toContain(
        '    page page-corrupt (revision rev-corrupt, sequence 7): materializePendingEntry: revision rev-corrupt historySequence mismatch',
      );
    });
  });

  describe('unsequencedRevisions', () => {
    it('exits 0 and omits detail sections for a clean run', () => {
      const { lines, exitCode } = formatRepairReport({
        unsequencedRevisions: { scannedPages: 3, repaired: [], blocked: [], failed: [], lastPageId: 'page-c' },
      });
      expect(exitCode).toBe(0);
      expect(lines).toEqual(['unsequenced-revision scan: scanned=3 repaired=0 blocked=0 failed=0 lastPageId=page-c']);
    });

    it('lists every assigned sequence with its page/revision id and the reason it was assigned', () => {
      const { lines, exitCode } = formatRepairReport({
        unsequencedRevisions: {
          scannedPages: 1,
          repaired: [
            {
              pageId: 'page-a',
              revisionId: 'rev-1',
              assignedSequence: 1,
              reason: 'unsequenced Revision assigned a sequence in createdAt,_id order (oldest first) by the repair scan',
            },
          ],
          blocked: [],
          failed: [],
          lastPageId: 'page-a',
        },
      });
      expect(exitCode).toBe(0);
      expect(lines).toContain('  assigned sequences:');
      expect(lines).toContain(
        '    page page-a revision rev-1: sequence 1 — unsequenced Revision assigned a sequence in createdAt,_id order (oldest first) by the repair scan',
      );
    });

    it('lists every blocked page with its duplicate sequence and reason, and exits 2', () => {
      const { lines, exitCode } = formatRepairReport({
        unsequencedRevisions: {
          scannedPages: 1,
          repaired: [],
          blocked: [{ pageId: 'page-dup', duplicateSequence: 5, reason: 'duplicate historySequence across Revision/PageHistoryEvent' }],
          failed: [],
          lastPageId: 'page-dup',
        },
      });
      expect(exitCode).toBe(2);
      expect(lines).toContain('  blocked pages (needs manual investigation, NOT auto-repaired):');
      expect(lines).toContain('    page page-dup: duplicateSequence=5 — duplicate historySequence across Revision/PageHistoryEvent');
    });

    it('includes the blocking Revision id when the service reports one', () => {
      const { lines } = formatRepairReport({
        unsequencedRevisions: {
          scannedPages: 1,
          repaired: [],
          blocked: [
            {
              pageId: 'page-dup',
              revisionId: 'rev-dup',
              duplicateSequence: 5,
              reason:
                'duplicate historySequence across Revision/PageHistoryEvent (revision rev-dup, revision rev-dup-2) — blocked for manual repair, not auto-fixed',
            },
          ],
          failed: [],
          lastPageId: 'page-dup',
        },
      });
      expect(lines).toContain(
        '    page page-dup (revision rev-dup): duplicateSequence=5 — duplicate historySequence across Revision/PageHistoryEvent (revision rev-dup, revision rev-dup-2) — blocked for manual repair, not auto-fixed',
      );
    });

    it('lists every scan failure with its page id and reason, and exits 2', () => {
      const { lines, exitCode } = formatRepairReport({
        unsequencedRevisions: {
          scannedPages: 1,
          repaired: [],
          blocked: [],
          failed: [{ pageId: 'page-bad', reason: 'materializePendingEntry: revision not found' }],
          lastPageId: 'page-bad',
        },
      });
      expect(exitCode).toBe(2);
      expect(lines).toContain('  scan failures (needs manual investigation):');
      expect(lines).toContain('    page page-bad: materializePendingEntry: revision not found');
    });

    it('includes the failed Revision id when the service reports one (no sequence — the claim never won one)', () => {
      const { lines } = formatRepairReport({
        unsequencedRevisions: {
          scannedPages: 1,
          repaired: [],
          blocked: [],
          failed: [{ pageId: 'page-bad', revisionId: 'rev-bad', reason: 'materializePendingEntry: malformed entry' }],
          lastPageId: 'page-bad',
        },
      });
      expect(lines).toContain('    page page-bad (revision rev-bad): materializePendingEntry: malformed entry');
    });
  });

  it('exits 2 when outbox is clean but the unsequenced-revision scan is blocked (worst case wins)', () => {
    const { exitCode } = formatRepairReport({
      outbox: { scannedPages: 0, repairedPageIds: [], failed: [], lastPageId: null },
      unsequencedRevisions: {
        scannedPages: 1,
        repaired: [],
        blocked: [{ pageId: 'page-dup', duplicateSequence: 2, reason: 'duplicate' }],
        failed: [],
        lastPageId: 'page-dup',
      },
    });
    expect(exitCode).toBe(2);
  });

  it('exits 2 when the unsequenced-revision scan is clean but outbox has a failure (worst case wins)', () => {
    const { exitCode } = formatRepairReport({
      outbox: { scannedPages: 1, repairedPageIds: [], failed: [{ pageId: 'page-corrupt', reason: 'boom' }], lastPageId: 'page-corrupt' },
      unsequencedRevisions: { scannedPages: 0, repaired: [], blocked: [], failed: [], lastPageId: null },
    });
    expect(exitCode).toBe(2);
  });

  /**
   * AC-8b (feature-page-history-phase1-model) — `@crowi/api`'s
   * `service/page-history/repair.ts` redacts any raw field value out of a
   * `reason` string BEFORE it ever reaches this summary (a Mongoose
   * validation error's `.message` otherwise embeds the raw violating
   * value). This formatter is a pure pass-through of whatever `reason`
   * string it's given, so its own obligation is narrower: never introduce
   * a leak of its own by, e.g., logging a raw summary object instead of
   * the already-redacted strings. Locks that an already-redacted reason
   * (`field: [redacted]`) prints verbatim, with no secret substring
   * anywhere in the rendered report.
   */
  it('prints an already-redacted reason verbatim and introduces no secret of its own', () => {
    const secretLookingValue = 'someone-secret@example.com';
    const { lines } = formatRepairReport({
      outbox: {
        scannedPages: 1,
        repairedPageIds: [],
        failed: [{ pageId: 'page-corrupt', reason: 'validation failed: payload.status: [redacted]' }],
        lastPageId: 'page-corrupt',
      },
    });
    const rendered = lines.join('\n');
    expect(rendered).toContain('payload.status: [redacted]');
    expect(rendered).not.toContain(secretLookingValue);
  });
});

/**
 * AC-8b (codex review attempt 2, round 6) — `formatFatalErrorLine` is what
 * the `page-history repair` action routes the two escaping-error catch
 * blocks (Crowi init failure / the repair call itself throwing) through,
 * instead of printing `err.message`/`err.stack` directly. This locks that
 * the raw error is NEVER read by this formatter itself — only the value the
 * injected `redact` function returns ends up in the printed line — without
 * needing a real Mongoose error or this file's CLI boot ceremony.
 */
describe('transitions (RFC-0021 Phase 2c-2a)', () => {
  it('exits 0 and reports what it settled', () => {
    const { lines, exitCode } = formatRepairReport({
      transitions: {
        scannedOperations: 2,
        reports: [
          { operationId: 'op-1', pageId: 'page-1', path: '/moved', action: 'completed', reason: 'transition-already-settled' },
          { operationId: 'op-2', pageId: 'page-2', path: '/held', action: 'resumed', reason: 'transition-held-by-operation' },
        ],
        failed: [],
        lastOperationId: 'op-2',
      },
    });
    expect(exitCode).toBe(0);
    expect(lines).toContain('transition sweep: scanned=2 resumed=1 completed=1 blocked=0 failed=0 lastOperationId=op-2');
    expect(lines).toContain('    operation op-1 page page-1 path /moved: completed — transition-already-settled');
  });

  it('AC-25/AC-27: names the blocked operation, page and path, and exits 2', () => {
    // The identifiers are the point: an operator who cannot name the stuck page
    // cannot act on it. Only driver text is withheld, and the service redacts
    // that before it ever reaches here.
    const { lines, exitCode } = formatRepairReport({
      transitions: {
        scannedOperations: 1,
        reports: [{ operationId: 'op-stuck', pageId: 'page-stuck', path: '/stuck', action: 'blocked', reason: 'unrecognised-page-state' }],
        failed: [],
        lastOperationId: 'op-stuck',
      },
    });
    expect(exitCode).toBe(2);
    expect(lines).toContain('  blocked transitions (needs manual investigation, NOT auto-repaired):');
    expect(lines).toContain('    operation op-stuck page page-stuck path /stuck: unrecognised-page-state');
  });

  it('AC-27: reports a sweep failure by operation id and exits 2', () => {
    const { lines, exitCode } = formatRepairReport({
      transitions: {
        scannedOperations: 1,
        reports: [],
        failed: [{ operationId: 'op-broken', reason: 'cast failed: page: [redacted]' }],
        lastOperationId: 'op-broken',
      },
    });
    expect(exitCode).toBe(2);
    expect(lines).toContain('  transition sweep failures (needs manual investigation):');
    expect(lines).toContain('    operation op-broken: cast failed: page: [redacted]');
  });
});

describe('formatFatalErrorLine', () => {
  it('routes the error through the provided redaction function and never touches err.message/stack directly', () => {
    const secretLookingValue = 'someone-secret@example.com';
    const err = new Error(`CastError: Cast to Number failed for value "${secretLookingValue}"`);
    const fakeRedact = jest.fn().mockReturnValue('cast failed: field: [redacted]');

    const line = formatFatalErrorLine('crowi-admin: failed to initialise Crowi: ', err, fakeRedact);

    expect(fakeRedact).toHaveBeenCalledWith(err);
    expect(line).toBe('crowi-admin: failed to initialise Crowi: cast failed: field: [redacted]');
    expect(line).not.toContain(secretLookingValue);
  });

  it('passes non-Error thrown values through to the redaction function unchanged', () => {
    const fakeRedact = jest.fn().mockReturnValue('unknown error');
    const line = formatFatalErrorLine('  reason: ', 'a plain string throw', fakeRedact);
    expect(fakeRedact).toHaveBeenCalledWith('a plain string throw');
    expect(line).toBe('  reason: unknown error');
  });
});
