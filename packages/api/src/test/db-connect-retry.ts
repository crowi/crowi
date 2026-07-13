/**
 * Test-harness-only bounded retry for `beforeAll`'s DB connect step
 * (feature-test-parallel-db-flake-hardening, Phase 1 / A1-1).
 *
 * `setupDatabase()` (`src/crowi/index.ts`) calls `mongoose.connect()` as a
 * one-shot, no-retry operation — that is production boot posture and is
 * deliberately UNCHANGED by this module. Under a full parallel jest run
 * (`--maxWorkers=5` against one shared mongod) that one shot occasionally
 * hits a transient connection failure. `bootCrowiWithRetry` below retries
 * ONLY that narrow failure class, at most once, from the test harness side
 * — it never touches `setupDatabase()` itself.
 *
 * ── Classification (`isRetryableConnectFailure`) ──
 *
 * A failure is retried IFF (a) AND (b):
 *
 *   (a) it is the exact wrapper `setupDatabase()`'s catch block throws —
 *       `new Error('Cannot connect to Database Server: ' + e.message, {
 *       cause: e })`. That message prefix is produced by that one catch
 *       block only, so matching it proves `setupModels()` has not run yet
 *       on this attempt — the retried attempt (a brand-new `Crowi`) is
 *       therefore guaranteed to register every mongoose model for the
 *       first time and cannot hit `OverwriteModelError`.
 *   (b) walking `err.cause` recursively — and, for any
 *       `MongoServerSelectionError` / `MongooseServerSelectionError`
 *       encountered along the way, additionally unwrapping its
 *       `.reason.servers` (a `Map<string, ServerDescription>`; each
 *       `ServerDescription.error` is the individual connect failure for
 *       that server — see mongodb@7.2.0
 *       `lib/sdam/{topology_description,server_description}.js`) — turns
 *       up a node that is EITHER named `MongoNetworkError` /
 *       `MongoNetworkTimeoutError` OR carries a transient-network errno
 *       (`ECONNREFUSED` / `ETIMEDOUT` / `ECONNRESET` / `EAI_AGAIN`) as
 *       `.code`.
 *
 * `MongoServerSelectionError` / `MongooseServerSelectionError` matching by
 * themselves are NOT sufficient — both classes are also produced for Atlas
 * IP-whitelist errors, SSL misconfiguration, and auth failures (see
 * mongoose's `MongooseServerSelectionError.assimilateError()`), none of
 * which a retry would ever fix. Only the errno/name evidence inside the
 * chain proves a transient network condition.
 *
 * Deliberately NAME-based, not `instanceof`: `packages/api` does not
 * depend on `mongodb` directly (only transitively, via `mongoose`), and
 * the pnpm store holds 3 separate copies of it (6.20.0 / 7.2.0 / 7.4.0).
 * Adding `mongodb` as a devDependency for an `instanceof` check risks
 * resolving a different copy than the one mongoose actually throws,
 * silently turning the check into a permanent false negative. See the
 * spec's design section (A1-1) for the full trace through the
 * mongodb@7.2.0 source that this module was written against.
 *
 * A bare `MongoNetworkError` (no `cause`, no `.code`) is accepted as
 * evidence on its own: `mongodb@7.2.0`'s connection-establishment code
 * (`lib/cmap/connect.js`) intentionally throws one with neither when a
 * socket closes mid-handshake. The retry budget below (2 attempts total)
 * bounds the cost of the rare corner case where this signal is a
 * permanent DNS/TLS misconfiguration instead of a transient network blip.
 *
 * ── Side channel ──
 *
 * jest's `--json --outputFile` never captures per-test `console` output
 * (see the Phase 4 / B2 design), so a full-suite GREEN run that
 * nonetheless retried a connect would otherwise leave zero trace anywhere
 * a report could find it. Every retry is therefore ALSO appended, as one
 * JSON Lines row, to a run-scoped side-channel file
 * (`resolveRetryEventsPath()` below) that the (future) flake report reads.
 */
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import mongoose from 'mongoose';

const CONNECT_ERROR_MESSAGE_PREFIX = 'Cannot connect to Database Server:';

const RETRYABLE_ERROR_NAMES = new Set(['MongoNetworkError', 'MongoNetworkTimeoutError']);
const RETRYABLE_ERRNOS = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN']);

/** Initial attempt + 1 retry — never more. */
export const MAX_CONNECT_ATTEMPTS = 2;
export const BACKOFF_MIN_MS = 500;
export const BACKOFF_MAX_MS = 2000;

/**
 * Documentation-only: the driver's default `serverSelectionTimeoutMS` /
 * `connectTimeoutMS`, which this harness deliberately does NOT shorten for
 * the `beforeAll` boot connection (see the design doc's A1-1/A1-3 — a
 * short timeout here would also cap the test body's own DB operations,
 * which reuse this same connection for the rest of the file's lifetime).
 * Used below only to prove the retry budget fits inside the `beforeAll`
 * hook timeout `setup.ts` sets for this call.
 */
export const DRIVER_DEFAULT_SERVER_SELECTION_TIMEOUT_MS = 30000;

/**
 * Worst case: `MAX_CONNECT_ATTEMPTS` full-length connect attempts plus one
 * backoff between them, must fit comfortably inside the 90000ms
 * `beforeAll` hook timeout (`setup.ts`) with room to spare for the rest of
 * `crowi.init()`'s boot layers (models/redis/config/migrations/renderer/
 * plugins/mailer) that run after the connect step. 2 * 30000 + 2000 =
 * 62000 < 90000 — verified numerically in `db-connect-retry.test.ts` too.
 */
export const BEFORE_ALL_HOOK_TIMEOUT_MS = 90000;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

/**
 * Depth-first collection of every error-shaped node reachable from `root`
 * by following `.cause` links and, for server-selection errors, also
 * unwrapping `.reason.servers` (see the module doc comment above).
 * `seen` guards against reference cycles; `root` itself is included as the
 * first element.
 */
function collectErrorChain(root: unknown, seen: Set<unknown> = new Set()): UnknownRecord[] {
  if (!isRecord(root) || seen.has(root)) return [];
  seen.add(root);

  const chain: UnknownRecord[] = [root];

  if ('cause' in root) {
    chain.push(...collectErrorChain(root.cause, seen));
  }

  const reason = root.reason;
  if (isRecord(reason) && reason.servers instanceof Map) {
    for (const serverDescription of reason.servers.values()) {
      if (isRecord(serverDescription) && 'error' in serverDescription) {
        chain.push(...collectErrorChain(serverDescription.error, seen));
      }
    }
  }

  return chain;
}

/**
 * Returns the first matching retry-evidence token found in `chain` — an
 * error `name` (`MongoNetworkError` / `MongoNetworkTimeoutError`) is
 * preferred over an errno `code`, purely for a more informative log/event;
 * either is equally sufficient evidence. `null` when neither is present.
 */
function findRetryEvidence(chain: UnknownRecord[]): string | null {
  for (const node of chain) {
    const name = node.name;
    if (typeof name === 'string' && RETRYABLE_ERROR_NAMES.has(name)) return name;
  }
  for (const node of chain) {
    const code = node.code;
    if (typeof code === 'string' && RETRYABLE_ERRNOS.has(code)) return code;
  }
  return null;
}

interface ConnectFailureClassification {
  retryable: boolean;
  /** The matched `MongoNetworkError`/`MongoNetworkTimeoutError` name or errno, or `null` when not retryable. */
  errnoOrClass: string | null;
}

function classifyConnectFailure(err: unknown): ConnectFailureClassification {
  if (!(err instanceof Error) || !err.message.startsWith(CONNECT_ERROR_MESSAGE_PREFIX)) {
    return { retryable: false, errnoOrClass: null };
  }
  const chain = collectErrorChain((err as { cause?: unknown }).cause);
  const errnoOrClass = findRetryEvidence(chain);
  return { retryable: errnoOrClass !== null, errnoOrClass };
}

/**
 * `true` iff `err` is a `setupDatabase()` connect failure AND its cause
 * chain carries transient-network evidence (see the module doc comment's
 * "Classification" section for the exact AND condition).
 */
export function isRetryableConnectFailure(err: unknown): boolean {
  return classifyConnectFailure(err).retryable;
}

function fullJitterBackoffMs(): number {
  return BACKOFF_MIN_MS + Math.random() * (BACKOFF_MAX_MS - BACKOFF_MIN_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run-scoped side-channel path:
 * `os.tmpdir()/crowi-api-test-retry-events.<CROWI_TEST_RUN_ID>.jsonl`.
 *
 * `CROWI_TEST_RUN_ID` is always present by the time a worker reaches this
 * code — `global-setup.js` sets it (in the jest MAIN process, before any
 * worker forks) before writing the sentinel, and `child_process.fork`
 * copies `process.env` wholesale at fork time (see `test-mongo-sentinel.js`'s
 * `getSentinelPath()` doc comment for the same fork-timing argument, cited
 * from jest 29.7.0 / jest-worker 29.7.0 source). An absent value here is a
 * broken-harness condition, not a legitimate state to silently paper over
 * with a machine-shared fallback path — that is exactly the cross-run race
 * this feature fixes elsewhere (sentinel scoping), so this module holds
 * the same loud-failure line.
 */
export function resolveRetryEventsPath(): string {
  const runId = process.env.CROWI_TEST_RUN_ID;
  if (!runId) {
    throw new Error(
      '[test-harness] CROWI_TEST_RUN_ID is unset while recording a DB connect retry event — ' +
        'global-setup.js should have set it before this worker was forked. Refusing to fall back ' +
        'to a machine-shared path (see test-mongo-sentinel.js getSentinelPath()).',
    );
  }
  return join(tmpdir(), `crowi-api-test-retry-events.${runId}.jsonl`);
}

interface RetryEvent {
  timestamp: string;
  testFilePath: string;
  attempt: number;
  /** The matched `MongoNetworkError`/`MongoNetworkTimeoutError` name, or errno (e.g. `ETIMEDOUT`). */
  errnoOrClass: string;
  /** The original wrapped error message, for humans reading the JSONL directly. */
  message: string;
}

function recordRetry(event: RetryEvent): void {
  // `[test-harness] ` — NOT `[crowi] `. `setup.ts` silences every
  // `[crowi] `-prefixed console.warn as boot-time noise; using that prefix
  // here would make this warning invisible on screen even though "must be
  // visible" is the entire point of emitting it (the JSONL append below is
  // unaffected either way, but a retry that only shows up in a file no one
  // is looking at defeats half the purpose).
  console.warn(`[test-harness] ${event.testFilePath}: DB connect attempt ${event.attempt} failed (${event.errnoOrClass}) — retrying: ${event.message}`);
  appendFileSync(resolveRetryEventsPath(), `${JSON.stringify(event)}\n`);
}

/**
 * Boots a fresh `Crowi` with up to `MAX_CONNECT_ATTEMPTS` (2) tries,
 * retrying ONLY the failure class `isRetryableConnectFailure` recognizes.
 * Any other failure — on any attempt — propagates immediately.
 *
 * `buildCrowi` is called fresh on every attempt (a failed instance is
 * never reused): condition (a) of the classification guarantees
 * `setupModels()` never ran on a retried attempt, so the next attempt's
 * `crowi.init()` registers every mongoose model for the first time and
 * cannot collide with an existing registration. Before any attempt after
 * the first, `mongoose.disconnect()` is awaited (best-effort) so a
 * half-open socket from the failed attempt cannot bleed into the next
 * `mongoose.connect()`.
 *
 * `onInstanceCreated`, when passed, fires synchronously right after each
 * attempt's fresh instance is built — including the final attempt that
 * ultimately throws. `setup.ts`'s `beforeAll` uses it to keep its
 * module-level `crowi` binding pointing at a real instance on every code
 * path, so `afterAll` never dereferences `undefined` when every attempt
 * fails (see the in-loop comment below for the full rationale).
 */
export async function bootCrowiWithRetry<T extends { init(): Promise<void> }>(
  buildCrowi: () => T,
  testFilePath: string,
  /** Called with each attempt's fresh instance, before `init()` runs. See the function doc comment above. */
  onInstanceCreated?: (instance: T) => void,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt++) {
    const instance = buildCrowi();
    // Hand the freshly-built instance to the caller BEFORE awaiting
    // `init()` — mirrors the pre-retry `beforeAll`'s assignment order
    // (`crowi = new Crowi(...); await crowi.init();`, where `crowi` was
    // assigned even if `init()` then threw) so `afterAll`'s cleanup
    // (`drainSideEffects()` / `teardownForCli()`) always has a real, if
    // not fully initialized, instance to call — even when every attempt
    // fails or a non-retryable failure aborts on the first one. Without
    // this, a caller that only assigns its own binding from this
    // function's return value never observes an instance on the failure
    // path, and `afterAll` would dereference `undefined`.
    onInstanceCreated?.(instance);
    try {
      await instance.init();
      return instance;
    } catch (err) {
      lastErr = err;
      const classification = classifyConnectFailure(err);
      const isLastAttempt = attempt >= MAX_CONNECT_ATTEMPTS;
      if (isLastAttempt || !classification.retryable) {
        throw err;
      }
      recordRetry({
        timestamp: new Date().toISOString(),
        testFilePath,
        attempt,
        errnoOrClass: classification.errnoOrClass ?? 'unknown',
        message: err instanceof Error ? err.message : String(err),
      });
      await mongoose.disconnect().catch(() => {});
      await sleep(fullJitterBackoffMs());
    }
  }
  // Unreachable — the loop above always either returns or throws — but
  // keeps the function's return type honest for the type checker.
  throw lastErr;
}
