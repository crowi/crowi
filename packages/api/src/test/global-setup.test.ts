/**
 * Deterministic coverage for `global-setup.js`'s Mongo URI resolution
 * priority (feature-test-parallel-db-flake-hardening, Phase 2 / A2):
 *
 *   `MONGO_URI` (hard override, no probe at all)
 *   > `TEST_MONGO_URI` (probed as the candidate itself, REGARDLESS of `CI` —
 *     never falls through to the 27018/27017 auto-detect cascade)
 *   > `CI === 'true'` guard (only reached when `TEST_MONGO_URI` is unset;
 *     blocks the 27018/27017 auto-detect cascade from ever running in CI)
 *   > `crowi-test-mongodb` (port 27018) probe
 *   > dev `mongodb` (port 27017) probe
 *   > `null` / empty sentinel (per-file `mongodb-memory-server` fallback,
 *     which `crowi-environment.js` — not this module — actually spins up)
 *
 * `resolveDockerCandidateUri` (the bottom 3 rungs) is exercised directly
 * with an injected fake `probeTcp` — no real TCP listeners, fully
 * deterministic. `globalSetup` itself (all 5 rungs, including the
 * `MONGO_URI`/`TEST_MONGO_URI`/CI short-circuits that sit ahead of the
 * cascade, AND the "sacred order" proof that `TEST_MONGO_URI` outranks the
 * CI guard rather than the other way around) is exercised end-to-end: real
 * sentinel file I/O, same fake probe injected as its test-only 3rd argument
 * (`deps.probeTcp`, see the module's doc comment — jest itself never passes
 * a 3rd argument, so production behaviour is unchanged).
 *
 * Every `globalSetup` test isolates its own `CROWI_TEST_RUN_ID` before
 * calling in: the REAL one is already set (inherited from this worker's
 * fork, per `test-mongo-sentinel.js`) and points at the ambient run's real
 * sentinel file — every other test file sharing this worker, and every
 * other worker in this run, may read it. Overwriting it for real here would
 * race them; a fresh id per test keeps `globalSetup`'s `??=` a no-op and
 * scopes every read/write below to a file only this test ever touches.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';

// `global-setup.js` / `test-mongo-sentinel.js` are plain CJS with no type
// declarations — required directly rather than imported (same pattern as
// `crowi-environment.test.ts`).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const globalSetup = require('./global-setup');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getSentinelPath } = require('./test-mongo-sentinel');

type ProbeFn = (uri: string, timeoutMs: number) => Promise<boolean>;

const { resolveDockerCandidateUri, TEST_MONGODB_URI, DEV_MONGO_URI } = globalSetup.__test__ as {
  resolveDockerCandidateUri: (opts: { testMongoUriEnv: string | undefined; probe: ProbeFn }) => Promise<string | null>;
  probeTcp: ProbeFn;
  TEST_MONGODB_URI: string;
  DEV_MONGO_URI: string;
};

/** Fake `probeTcp`: resolves `true` iff `uri` is in `reachable`; records every call. */
function fakeProbe(reachable: Set<string>): { probe: ProbeFn; calls: string[] } {
  const calls: string[] = [];
  const probe: ProbeFn = async (uri) => {
    calls.push(uri);
    return reachable.has(uri);
  };
  return { probe, calls };
}

// ---------------------------------------------------------------------------
// resolveDockerCandidateUri — the 27018 -> 27017 -> null cascade, and the
// TEST_MONGO_URI override that bypasses it entirely
// ---------------------------------------------------------------------------

describe('resolveDockerCandidateUri', () => {
  it('probes ONLY the TEST_MONGO_URI candidate when set, and returns it when reachable — never touches 27018/27017', async () => {
    const override = 'mongodb://example.invalid:27099/?maxPoolSize=10';
    const { probe, calls } = fakeProbe(new Set([override, TEST_MONGODB_URI, DEV_MONGO_URI]));

    const result = await resolveDockerCandidateUri({ testMongoUriEnv: override, probe });

    expect(result).toBe(override);
    // Exactly one probe call, against the override only — proves 27018/27017
    // were never even attempted (a `.every()` on an empty/short array would
    // pass vacuously; pinning the full call list rules that out).
    expect(calls).toEqual([override]);
  });

  it('does NOT fall through to 27018/27017 when TEST_MONGO_URI is set but unreachable — returns null even though 27018 IS reachable', async () => {
    const override = 'mongodb://example.invalid:27099/?maxPoolSize=10';
    const { probe, calls } = fakeProbe(new Set([TEST_MONGODB_URI, DEV_MONGO_URI]));

    const result = await resolveDockerCandidateUri({ testMongoUriEnv: override, probe });

    expect(result).toBeNull();
    // Both probe attempts (the transient-stall retry from `probeReachable`)
    // target the override only — 27018/27017 (both reachable per the `Set`
    // above) are never in the call list.
    expect(calls).toEqual([override, override]);
  });

  it('adopts crowi-test-mongodb (27018) when reachable, without ever probing the dev mongo (27017)', async () => {
    const { probe, calls } = fakeProbe(new Set([TEST_MONGODB_URI, DEV_MONGO_URI]));

    const result = await resolveDockerCandidateUri({ testMongoUriEnv: undefined, probe });

    expect(result).toBe(TEST_MONGODB_URI);
    // Exactly one probe call, against 27018 only.
    expect(calls).toEqual([TEST_MONGODB_URI]);
  });

  it('falls back to the dev mongo (27017) when crowi-test-mongodb (27018) is unreachable', async () => {
    const { probe, calls } = fakeProbe(new Set([DEV_MONGO_URI]));

    const result = await resolveDockerCandidateUri({ testMongoUriEnv: undefined, probe });

    expect(result).toBe(DEV_MONGO_URI);
    // 27018 is probed TWICE (the transient-stall retry from `probeReachable`
    // fires because it's unreachable both times) BEFORE falling through to
    // 27017 — pin the exact ordered call list, not just each URI's
    // individual presence.
    expect(calls).toEqual([TEST_MONGODB_URI, TEST_MONGODB_URI, DEV_MONGO_URI]);
  });

  it('returns null (memory-server fallback) when neither 27018 nor 27017 is reachable', async () => {
    const { probe, calls } = fakeProbe(new Set());

    const result = await resolveDockerCandidateUri({ testMongoUriEnv: undefined, probe });

    expect(result).toBeNull();
    // Both candidates are probed TWICE each (the transient-stall retry from
    // `probeReachable` fires for both, since neither ever answers) before
    // giving up — pin the exact ordered call list, not just the null result.
    expect(calls).toEqual([TEST_MONGODB_URI, TEST_MONGODB_URI, DEV_MONGO_URI, DEV_MONGO_URI]);
  });

  it('retries a transient single-probe failure against the SAME candidate before giving up on it, without falling through to the next rung', async () => {
    let calls = 0;
    const probe: ProbeFn = async (uri) => {
      calls += 1;
      // First attempt against 27018 fails, second (retry) succeeds.
      return uri === TEST_MONGODB_URI && calls >= 2;
    };

    const result = await resolveDockerCandidateUri({ testMongoUriEnv: undefined, probe });

    expect(result).toBe(TEST_MONGODB_URI);
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// globalSetup — end-to-end (real sentinel file I/O), including the
// MONGO_URI / CI short-circuits that sit ahead of the probe cascade
// ---------------------------------------------------------------------------

describe('globalSetup', () => {
  const originalRunId = process.env.CROWI_TEST_RUN_ID;
  const originalMongoUri = process.env.MONGO_URI;
  const originalTestMongoUri = process.env.TEST_MONGO_URI;
  const originalCi = process.env.CI;

  beforeEach(() => {
    process.env.CROWI_TEST_RUN_ID = `global-setup-test-${randomUUID()}`;
  });

  afterEach(() => {
    try {
      rmSync(getSentinelPath(), { force: true });
    } catch {
      // best-effort cleanup
    }
    if (originalRunId === undefined) delete process.env.CROWI_TEST_RUN_ID;
    else process.env.CROWI_TEST_RUN_ID = originalRunId;
    if (originalMongoUri === undefined) delete process.env.MONGO_URI;
    else process.env.MONGO_URI = originalMongoUri;
    if (originalTestMongoUri === undefined) delete process.env.TEST_MONGO_URI;
    else process.env.TEST_MONGO_URI = originalTestMongoUri;
    if (originalCi === undefined) delete process.env.CI;
    else process.env.CI = originalCi;
  });

  function sentinelContent(): string {
    return readFileSync(getSentinelPath(), 'utf8');
  }

  it('MONGO_URI hard override: writes an empty sentinel and never probes', async () => {
    process.env.MONGO_URI = 'mongodb://example.invalid:27017/whatever';
    delete process.env.TEST_MONGO_URI;
    delete process.env.CI;
    const { probe, calls } = fakeProbe(new Set([TEST_MONGODB_URI, DEV_MONGO_URI]));

    await globalSetup(undefined, undefined, { probeTcp: probe });

    expect(sentinelContent()).toBe('');
    expect(calls).toHaveLength(0);
  });

  it('CI fast-fail path (no TEST_MONGO_URI): writes an empty sentinel and never probes', async () => {
    delete process.env.MONGO_URI;
    delete process.env.TEST_MONGO_URI;
    process.env.CI = 'true';
    const { probe, calls } = fakeProbe(new Set([TEST_MONGODB_URI, DEV_MONGO_URI]));

    await globalSetup(undefined, undefined, { probeTcp: probe });

    expect(sentinelContent()).toBe('');
    expect(calls).toHaveLength(0);
  });

  it('sacred priority order: TEST_MONGO_URI still wins over the CI auto-detect guard — CI does NOT short-circuit ahead of an explicit override', async () => {
    delete process.env.MONGO_URI;
    process.env.CI = 'true';
    const override = 'mongodb://example.invalid:27099/?maxPoolSize=10';
    process.env.TEST_MONGO_URI = override;
    const { probe, calls } = fakeProbe(new Set([override, TEST_MONGODB_URI, DEV_MONGO_URI]));

    await globalSetup(undefined, undefined, { probeTcp: probe });

    expect(sentinelContent()).toBe(override);
    // Exactly one probe call, against the override only.
    expect(calls).toEqual([override]);
  });

  it('CI + unreachable TEST_MONGO_URI: falls straight to the memory-server sentinel WITHOUT the CI guard reviving the 27018/27017 cascade', async () => {
    delete process.env.MONGO_URI;
    process.env.CI = 'true';
    const override = 'mongodb://example.invalid:27099/?maxPoolSize=10';
    process.env.TEST_MONGO_URI = override;
    const { probe, calls } = fakeProbe(new Set([TEST_MONGODB_URI, DEV_MONGO_URI]));

    await globalSetup(undefined, undefined, { probeTcp: probe });

    expect(sentinelContent()).toBe('');
    // Both retry attempts target the override only — 27018/27017 (both
    // reachable per the `Set` above) never appear in the call list.
    expect(calls).toEqual([override, override]);
  });

  it('TEST_MONGO_URI override: writes it to the sentinel when reachable, probing only that candidate (never 27018/27017)', async () => {
    delete process.env.MONGO_URI;
    delete process.env.CI;
    const override = 'mongodb://example.invalid:27099/?maxPoolSize=10';
    process.env.TEST_MONGO_URI = override;
    const { probe, calls } = fakeProbe(new Set([override, TEST_MONGODB_URI, DEV_MONGO_URI]));

    await globalSetup(undefined, undefined, { probeTcp: probe });

    expect(sentinelContent()).toBe(override);
    // Exactly one probe call, against the override only.
    expect(calls).toEqual([override]);
  });

  it('no env override, crowi-test-mongodb (27018) reachable: writes the 27018 URI, never probing 27017', async () => {
    delete process.env.MONGO_URI;
    delete process.env.TEST_MONGO_URI;
    delete process.env.CI;
    const { probe, calls } = fakeProbe(new Set([TEST_MONGODB_URI, DEV_MONGO_URI]));

    await globalSetup(undefined, undefined, { probeTcp: probe });

    expect(sentinelContent()).toBe(TEST_MONGODB_URI);
    // Exactly one probe call, against 27018 only — pinning the full call
    // list (not just asserting DEV_MONGO_URI's absence) rules out a vacuous
    // pass if the call list were ever empty for an unrelated reason.
    expect(calls).toEqual([TEST_MONGODB_URI]);
  });

  it('no env override, 27018 unreachable, dev mongo (27017) reachable: writes the 27017 URI', async () => {
    delete process.env.MONGO_URI;
    delete process.env.TEST_MONGO_URI;
    delete process.env.CI;
    const { probe, calls } = fakeProbe(new Set([DEV_MONGO_URI]));

    await globalSetup(undefined, undefined, { probeTcp: probe });

    expect(sentinelContent()).toBe(DEV_MONGO_URI);
    // 27018 is probed TWICE (the transient-stall retry fires because it's
    // unreachable both times) BEFORE falling through to 27017 — pin the
    // exact ordered call list so this proves the cascade order, not just
    // that both ports were touched at some point.
    expect(calls).toEqual([TEST_MONGODB_URI, TEST_MONGODB_URI, DEV_MONGO_URI]);
  });

  it('no env override, neither reachable: writes an empty sentinel (memory-server fallback)', async () => {
    delete process.env.MONGO_URI;
    delete process.env.TEST_MONGO_URI;
    delete process.env.CI;
    const { probe, calls } = fakeProbe(new Set());

    await globalSetup(undefined, undefined, { probeTcp: probe });

    expect(sentinelContent()).toBe('');
    // Both candidates are probed TWICE each (the transient-stall retry fires
    // for both, since neither ever answers) before giving up — pin the exact
    // ordered call list, not just the empty-sentinel result.
    expect(calls).toEqual([TEST_MONGODB_URI, TEST_MONGODB_URI, DEV_MONGO_URI, DEV_MONGO_URI]);
  });
});
