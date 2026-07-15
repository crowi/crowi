/**
 * Deterministic coverage for `failure-taxonomy-channel.js`
 * (feature-flake-failure-taxonomy AC-4): run id generation/scoping, exclusive
 * first-create + atomic append, and foreign/stale/malformed row rejection on
 * read. Real `fs` I/O against `os.tmpdir()`, not mocked — the same style
 * `db-connect-retry.test.ts` and `scripts/test-flake-report.test.mjs` use for
 * their own JSON Lines side channels.
 *
 * `failure-taxonomy-channel.js` is plain CJS with no type declarations —
 * required directly rather than imported (same pattern as
 * `crowi-environment.test.ts` / `global-setup.test.ts`).
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const channel = require('./failure-taxonomy-channel') as {
  RUN_ID_ENV_VAR: string;
  SCHEMA_VERSION: number;
  generateRunId: () => string;
  ensureRunId: () => string;
  currentRunId: () => string;
  resolveChannelPath: (runId: string) => string;
  appendRecord: (runId: string, record: Record<string, unknown>) => void;
  readChannel: (runId: string) => { records: Array<Record<string, unknown>>; warnings: string[]; filePath: string; existed: boolean };
  cleanupChannel: (runId: string) => void;
};

function freshRunId(): string {
  return `failure-taxonomy-channel-test-${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// generateRunId / ensureRunId / currentRunId
// ---------------------------------------------------------------------------

describe('generateRunId', () => {
  it('returns a distinct id on each call', () => {
    const a = channel.generateRunId();
    const b = channel.generateRunId();
    expect(a).not.toBe(b);
  });
});

describe('ensureRunId / currentRunId', () => {
  const originalEnv = process.env[channel.RUN_ID_ENV_VAR];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[channel.RUN_ID_ENV_VAR];
    else process.env[channel.RUN_ID_ENV_VAR] = originalEnv;
  });

  it('self-generates a fresh id when unset (bare `pnpm test`, no orchestrator)', () => {
    delete process.env[channel.RUN_ID_ENV_VAR];
    const runId = channel.ensureRunId();
    expect(typeof runId).toBe('string');
    expect(runId.length).toBeGreaterThan(0);
    expect(process.env[channel.RUN_ID_ENV_VAR]).toBe(runId);
  });

  it('is idempotent — adopts an externally pre-set value instead of overwriting it (lets an orchestrator like scripts/test-flake-taxonomy.mjs know the id ahead of time)', () => {
    process.env[channel.RUN_ID_ENV_VAR] = 'pre-set-by-orchestrator';
    expect(channel.ensureRunId()).toBe('pre-set-by-orchestrator');
  });

  it('currentRunId throws a diagnostic error instead of silently generating one when unset', () => {
    delete process.env[channel.RUN_ID_ENV_VAR];
    expect(() => channel.currentRunId()).toThrow(/CROWI_FAILURE_TAXONOMY_RUN_ID is unset/);
  });

  it('currentRunId returns the established value once ensureRunId has run', () => {
    delete process.env[channel.RUN_ID_ENV_VAR];
    const runId = channel.ensureRunId();
    expect(channel.currentRunId()).toBe(runId);
  });
});

describe('resolveChannelPath', () => {
  it('embeds the run id in the file name', () => {
    expect(channel.resolveChannelPath('abc123').endsWith('crowi-api-test-failure-taxonomy.abc123.jsonl')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// appendRecord / readChannel — exclusive create, atomic append, versioned envelope
// ---------------------------------------------------------------------------

describe('appendRecord + readChannel', () => {
  it('creates the file on first append and appends one JSON line per call', () => {
    const runId = freshRunId();
    try {
      channel.appendRecord(runId, { kind: 'authoritative-file-result', testFilePath: 'a.test.ts' });
      channel.appendRecord(runId, { kind: 'worker-enrichment', testFilePath: 'a.test.ts' });

      const filePath = channel.resolveChannelPath(runId);
      expect(existsSync(filePath)).toBe(true);
      const lines = readFileSync(filePath, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toMatchObject({ schemaVersion: channel.SCHEMA_VERSION, runId, kind: 'authoritative-file-result' });
      expect(JSON.parse(lines[1])).toMatchObject({ schemaVersion: channel.SCHEMA_VERSION, runId, kind: 'worker-enrichment' });
    } finally {
      rmSync(channel.resolveChannelPath(runId), { force: true });
    }
  });

  it('folds in schemaVersion/runId/recordedAt automatically — callers never set them', () => {
    const runId = freshRunId();
    try {
      channel.appendRecord(runId, { kind: 'authoritative-file-result' });
      const { records } = channel.readChannel(runId);
      expect(records).toHaveLength(1);
      expect(records[0].schemaVersion).toBe(channel.SCHEMA_VERSION);
      expect(records[0].runId).toBe(runId);
      expect(typeof records[0].recordedAt).toBe('string');
      expect(() => new Date(records[0].recordedAt as string).toISOString()).not.toThrow();
    } finally {
      channel.cleanupChannel(runId);
    }
  });

  it('readChannel on a run that never wrote anything returns existed: false, not an error', () => {
    const runId = freshRunId();
    const { records, warnings, existed } = channel.readChannel(runId);
    expect(existed).toBe(false);
    expect(records).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('rejects a foreign row (runId mismatch) with a warning instead of throwing or silently accepting it (AC-4)', () => {
    const runId = freshRunId();
    try {
      channel.appendRecord(runId, { kind: 'authoritative-file-result', testFilePath: 'own.test.ts' });
      // Simulate a foreign row landing in the same file (shouldn't happen
      // given the run-scoped path, but rejected defensively — see the
      // module doc comment).
      const filePath = channel.resolveChannelPath(runId);
      appendFileSync(filePath, `${JSON.stringify({ schemaVersion: channel.SCHEMA_VERSION, runId: 'some-other-run', kind: 'authoritative-file-result' })}\n`);

      const { records, warnings } = channel.readChannel(runId);
      expect(records).toHaveLength(1);
      expect(records[0].testFilePath).toBe('own.test.ts');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/foreign/);
    } finally {
      channel.cleanupChannel(runId);
    }
  });

  it('rejects a row with an unrecognized schemaVersion with a warning (stale writer / format drift)', () => {
    const runId = freshRunId();
    try {
      const filePath = channel.resolveChannelPath(runId);
      appendFileSync(filePath, `${JSON.stringify({ schemaVersion: 999, runId, kind: 'authoritative-file-result' })}\n`);

      const { records, warnings } = channel.readChannel(runId);
      expect(records).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/schemaVersion/);
    } finally {
      channel.cleanupChannel(runId);
    }
  });

  it('rejects a malformed (non-JSON) line with a warning instead of throwing', () => {
    const runId = freshRunId();
    try {
      const filePath = channel.resolveChannelPath(runId);
      appendFileSync(filePath, 'not json at all\n');

      const { records, warnings } = channel.readChannel(runId);
      expect(records).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/could not parse/);
    } finally {
      channel.cleanupChannel(runId);
    }
  });

  it('rejects a row missing a recognizable "kind" with a warning', () => {
    const runId = freshRunId();
    try {
      const filePath = channel.resolveChannelPath(runId);
      appendFileSync(filePath, `${JSON.stringify({ schemaVersion: channel.SCHEMA_VERSION, runId })}\n`);

      const { records, warnings } = channel.readChannel(runId);
      expect(records).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/no recognizable "kind"/);
    } finally {
      channel.cleanupChannel(runId);
    }
  });

  it('skips blank lines without warning', () => {
    const runId = freshRunId();
    try {
      channel.appendRecord(runId, { kind: 'authoritative-file-result' });
      const filePath = channel.resolveChannelPath(runId);
      appendFileSync(filePath, '\n\n');

      const { records, warnings } = channel.readChannel(runId);
      expect(records).toHaveLength(1);
      expect(warnings).toEqual([]);
    } finally {
      channel.cleanupChannel(runId);
    }
  });

  it('a second append does not re-create the file (EEXIST from ensureChannelFileCreated is swallowed as a benign peer-writer race)', () => {
    const runId = freshRunId();
    try {
      channel.appendRecord(runId, { kind: 'authoritative-file-result', testFilePath: 'first.test.ts' });
      expect(() => channel.appendRecord(runId, { kind: 'authoritative-file-result', testFilePath: 'second.test.ts' })).not.toThrow();
      const { records } = channel.readChannel(runId);
      expect(records.map((r) => r.testFilePath)).toEqual(['first.test.ts', 'second.test.ts']);
    } finally {
      channel.cleanupChannel(runId);
    }
  });
});

// ---------------------------------------------------------------------------
// cleanupChannel
// ---------------------------------------------------------------------------

describe('cleanupChannel', () => {
  it('removes the channel file', () => {
    const runId = freshRunId();
    channel.appendRecord(runId, { kind: 'authoritative-file-result' });
    const filePath = channel.resolveChannelPath(runId);
    expect(existsSync(filePath)).toBe(true);

    channel.cleanupChannel(runId);
    expect(existsSync(filePath)).toBe(false);
  });

  it('is a no-op (does not throw) for a run that never wrote a file', () => {
    expect(() => channel.cleanupChannel(freshRunId())).not.toThrow();
  });
});
