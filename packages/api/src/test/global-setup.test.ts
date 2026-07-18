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

// `global-setup.js` / `test-mongo-sentinel.js` / `redis-smoke-sentinel.js`
// are plain CJS with no type declarations — required directly rather than
// imported (same pattern as `crowi-environment.test.ts`).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const globalSetup = require('./global-setup');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getSentinelPath } = require('./test-mongo-sentinel');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { REDIS_SMOKE_TARGETS, getConnectivitySentinelPath, readConnectivitySentinel } = require('./redis-smoke-sentinel');

/**
 * feature-redis-8-upgrade Phase 2 — `globalSetup` now ALSO probes the 3
 * Redis smoke targets (see the new `describe('globalSetup — Redis smoke
 * connectivity probe', ...)` block below) on EVERY code path, before the
 * Mongo branching. The existing Mongo-focused `describe('globalSetup', ...)`
 * tests below therefore mark all 3 as reachable (one call each, via the same
 * injected fake `probe`) so their pre-existing `calls` assertions stay
 * meaningful for Mongo instead of also having to encode the Redis retry
 * cascade — the Redis probe's OWN behavior (reachable / unreachable / CI
 * fail-fast) gets its own dedicated tests instead.
 */
const REDIS_URLS: string[] = Object.values(REDIS_SMOKE_TARGETS);

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
    try {
      rmSync(getConnectivitySentinelPath(), { force: true });
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

  /**
   * Parses the sentinel as the Phase 3 / B3-2 `{ strategy, uri }` JSON
   * record every branch writes WITHOUT EXCEPTION (Phase 3 rework) —
   * including the `MONGO_URI` hard-override branch, which used to write
   * literal `''` but now records `{ strategy: 'env-override', uri:
   * process.env.MONGO_URI }` like every other branch.
   */
  function sentinelRecord(): { strategy: string; uri: string | null } {
    return JSON.parse(sentinelContent());
  }

  it('MONGO_URI hard override: records strategy env-override with the raw MONGO_URI value, and never probes Mongo (Redis smoke probe still runs, unconditionally)', async () => {
    process.env.MONGO_URI = 'mongodb://example.invalid:27017/whatever';
    delete process.env.TEST_MONGO_URI;
    delete process.env.CI;
    const { probe, calls } = fakeProbe(new Set([...REDIS_URLS, TEST_MONGODB_URI, DEV_MONGO_URI]));

    await globalSetup(undefined, undefined, { probeTcp: probe });

    expect(sentinelRecord()).toEqual({ strategy: 'env-override', uri: 'mongodb://example.invalid:27017/whatever' });
    // Only the 3 Redis smoke targets — Mongo's own MONGO_URI override branch
    // never probes.
    expect(calls).toEqual(REDIS_URLS);
  });

  it('CI fast-fail path (no TEST_MONGO_URI): records strategy memory-server and never probes Mongo (Redis smoke probe still runs, unconditionally)', async () => {
    delete process.env.MONGO_URI;
    delete process.env.TEST_MONGO_URI;
    process.env.CI = 'true';
    const { probe, calls } = fakeProbe(new Set([...REDIS_URLS, TEST_MONGODB_URI, DEV_MONGO_URI]));

    await globalSetup(undefined, undefined, { probeTcp: probe });

    expect(sentinelRecord()).toEqual({ strategy: 'memory-server', uri: null });
    expect(calls).toEqual(REDIS_URLS);
  });

  it('sacred priority order: TEST_MONGO_URI still wins over the CI auto-detect guard — CI does NOT short-circuit ahead of an explicit override', async () => {
    delete process.env.MONGO_URI;
    process.env.CI = 'true';
    const override = 'mongodb://example.invalid:27099/?maxPoolSize=10';
    process.env.TEST_MONGO_URI = override;
    const { probe, calls } = fakeProbe(new Set([...REDIS_URLS, override, TEST_MONGODB_URI, DEV_MONGO_URI]));

    await globalSetup(undefined, undefined, { probeTcp: probe });

    expect(sentinelRecord()).toEqual({ strategy: 'env-override', uri: override });
    // The 3 Redis smoke targets (unconditional), then exactly one Mongo
    // probe call, against the override only.
    expect(calls).toEqual([...REDIS_URLS, override]);
  });

  it('CI + unreachable TEST_MONGO_URI: falls straight to the memory-server sentinel WITHOUT the CI guard reviving the 27018/27017 cascade', async () => {
    delete process.env.MONGO_URI;
    process.env.CI = 'true';
    const override = 'mongodb://example.invalid:27099/?maxPoolSize=10';
    process.env.TEST_MONGO_URI = override;
    const { probe, calls } = fakeProbe(new Set([...REDIS_URLS, TEST_MONGODB_URI, DEV_MONGO_URI]));

    await globalSetup(undefined, undefined, { probeTcp: probe });

    expect(sentinelRecord()).toEqual({ strategy: 'memory-server', uri: null });
    // The 3 Redis smoke targets (unconditional), then both retry attempts
    // against the override only — 27018/27017 (both reachable per the `Set`
    // above) never appear in the call list.
    expect(calls).toEqual([...REDIS_URLS, override, override]);
  });

  it('TEST_MONGO_URI override: records strategy env-override when reachable, probing only that candidate (never 27018/27017)', async () => {
    delete process.env.MONGO_URI;
    delete process.env.CI;
    const override = 'mongodb://example.invalid:27099/?maxPoolSize=10';
    process.env.TEST_MONGO_URI = override;
    const { probe, calls } = fakeProbe(new Set([...REDIS_URLS, override, TEST_MONGODB_URI, DEV_MONGO_URI]));

    await globalSetup(undefined, undefined, { probeTcp: probe });

    expect(sentinelRecord()).toEqual({ strategy: 'env-override', uri: override });
    // The 3 Redis smoke targets (unconditional), then exactly one Mongo
    // probe call, against the override only.
    expect(calls).toEqual([...REDIS_URLS, override]);
  });

  it('no env override, crowi-test-mongodb (27018) reachable: records strategy docker-test, never probing 27017', async () => {
    delete process.env.MONGO_URI;
    delete process.env.TEST_MONGO_URI;
    delete process.env.CI;
    const { probe, calls } = fakeProbe(new Set([...REDIS_URLS, TEST_MONGODB_URI, DEV_MONGO_URI]));

    await globalSetup(undefined, undefined, { probeTcp: probe });

    expect(sentinelRecord()).toEqual({ strategy: 'docker-test', uri: TEST_MONGODB_URI });
    // The 3 Redis smoke targets (unconditional), then exactly one Mongo
    // probe call, against 27018 only — pinning the full call list (not just
    // asserting DEV_MONGO_URI's absence) rules out a vacuous pass if the
    // call list were ever empty for an unrelated reason.
    expect(calls).toEqual([...REDIS_URLS, TEST_MONGODB_URI]);
  });

  it('no env override, 27018 unreachable, dev mongo (27017) reachable: records strategy docker-dev', async () => {
    delete process.env.MONGO_URI;
    delete process.env.TEST_MONGO_URI;
    delete process.env.CI;
    const { probe, calls } = fakeProbe(new Set([...REDIS_URLS, DEV_MONGO_URI]));

    await globalSetup(undefined, undefined, { probeTcp: probe });

    expect(sentinelRecord()).toEqual({ strategy: 'docker-dev', uri: DEV_MONGO_URI });
    // The 3 Redis smoke targets (unconditional), then 27018 probed TWICE
    // (the transient-stall retry fires because it's unreachable both times)
    // BEFORE falling through to 27017 — pin the exact ordered call list so
    // this proves the cascade order, not just that both ports were touched
    // at some point.
    expect(calls).toEqual([...REDIS_URLS, TEST_MONGODB_URI, TEST_MONGODB_URI, DEV_MONGO_URI]);
  });

  it('no env override, neither reachable: records strategy memory-server (Redis smoke targets also unreachable, but non-CI so no throw)', async () => {
    delete process.env.MONGO_URI;
    delete process.env.TEST_MONGO_URI;
    delete process.env.CI;
    const { probe, calls } = fakeProbe(new Set());

    await globalSetup(undefined, undefined, { probeTcp: probe });

    expect(sentinelRecord()).toEqual({ strategy: 'memory-server', uri: null });
    // Every Redis smoke target is probed TWICE (unreachable, same
    // transient-stall retry), then both Mongo candidates are probed TWICE
    // each — pin the exact ordered call list, not just the empty-sentinel
    // result.
    expect(calls).toEqual([...REDIS_URLS.flatMap((url) => [url, url]), TEST_MONGODB_URI, TEST_MONGODB_URI, DEV_MONGO_URI, DEV_MONGO_URI]);
  });

  it('does NOT throw locally (non-CI) when a Redis smoke target is unreachable — only records it in the connectivity sentinel', async () => {
    delete process.env.MONGO_URI;
    delete process.env.TEST_MONGO_URI;
    delete process.env.CI;
    const { probe } = fakeProbe(new Set([TEST_MONGODB_URI, DEV_MONGO_URI])); // no Redis URL reachable

    await expect(globalSetup(undefined, undefined, { probeTcp: probe })).resolves.toBeUndefined();

    const redisResult = readConnectivitySentinel();
    expect(redisResult).toEqual({
      shared: { url: REDIS_SMOKE_TARGETS.shared, reachable: false },
      config: { url: REDIS_SMOKE_TARGETS.config, reachable: false },
      tls: { url: REDIS_SMOKE_TARGETS.tls, reachable: false },
    });
  });

  it('CI + all Redis smoke targets reachable: does not throw, records reachable:true for all 3', async () => {
    process.env.CI = 'true';
    delete process.env.MONGO_URI;
    delete process.env.TEST_MONGO_URI;
    const { probe } = fakeProbe(new Set([...REDIS_URLS, TEST_MONGODB_URI, DEV_MONGO_URI]));

    await expect(globalSetup(undefined, undefined, { probeTcp: probe })).resolves.toBeUndefined();

    const redisResult = readConnectivitySentinel();
    expect(redisResult).toEqual({
      shared: { url: REDIS_SMOKE_TARGETS.shared, reachable: true },
      config: { url: REDIS_SMOKE_TARGETS.config, reachable: true },
      tls: { url: REDIS_SMOKE_TARGETS.tls, reachable: true },
    });
  });

  it('CI + a Redis smoke target unreachable: throws immediately (fail-fast — never silently skips in CI), naming the unreachable target', async () => {
    process.env.CI = 'true';
    delete process.env.MONGO_URI;
    delete process.env.TEST_MONGO_URI;
    // `config` (crowi-test-redis) missing from the reachable set.
    const { probe } = fakeProbe(new Set([REDIS_SMOKE_TARGETS.shared, REDIS_SMOKE_TARGETS.tls, TEST_MONGODB_URI, DEV_MONGO_URI]));

    await expect(globalSetup(undefined, undefined, { probeTcp: probe })).rejects.toThrow(/config/);
  });
});

// ---------------------------------------------------------------------------
// warnOnWorkerPoolDrift (Phase 3 / B3-3): maxWorkers vs. CPU count, and the
// estimated maxWorkers×maxPoolSize socket count vs. CPU count
// ---------------------------------------------------------------------------

describe('warnOnWorkerPoolDrift', () => {
  const { warnOnWorkerPoolDrift, ASSUMED_MAX_POOL_SIZE, SOCKET_BUDGET_PER_CPU } = globalSetup.__test__ as {
    warnOnWorkerPoolDrift: (globalConfig: { maxWorkers?: number } | undefined, deps: { cpuCount?: number }) => void;
    ASSUMED_MAX_POOL_SIZE: number;
    SOCKET_BUDGET_PER_CPU: number;
  };

  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('does NOT warn for the current accepted default (maxWorkers=5) on a normal multi-core machine', () => {
    warnOnWorkerPoolDrift({ maxWorkers: 5 }, { cpuCount: 8 });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns when maxWorkers exceeds the CPU count', () => {
    warnOnWorkerPoolDrift({ maxWorkers: 9 }, { cpuCount: 4 });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('exceeds this machine'));
  });

  it('warns when the estimated socket count is far beyond the CPU-count budget (e.g. maxPoolSize reverted toward the driver default)', () => {
    // maxWorkers(5) x ASSUMED_MAX_POOL_SIZE(10) = 50 estimated sockets;
    // cpuCount(1) x SOCKET_BUDGET_PER_CPU exceeded even though maxWorkers
    // itself (5) does not exceed cpuCount... except cpuCount=1 also trips
    // the maxWorkers check, so pin BOTH the socket-drift message AND that
    // the estimate in the message matches the documented formula.
    warnOnWorkerPoolDrift({ maxWorkers: 5 }, { cpuCount: 1 });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`~${5 * ASSUMED_MAX_POOL_SIZE}`));
    expect(SOCKET_BUDGET_PER_CPU).toBeGreaterThan(0);
  });

  it('never fails (throws) regardless of how extreme the input is — warn only, per B3-3', () => {
    expect(() => warnOnWorkerPoolDrift({ maxWorkers: 999 }, { cpuCount: 1 })).not.toThrow();
  });

  it('falls back to os.cpus().length when deps.cpuCount is not injected (production default)', () => {
    // No `cpuCount` in deps — must not throw, and must use the real
    // `os.cpus().length` (whatever it is on this machine) rather than
    // crashing on `undefined`.
    expect(() => warnOnWorkerPoolDrift({ maxWorkers: 1 }, {})).not.toThrow();
  });
});
