import type Crowi from 'src/crowi';
import { createLogger, createLogRecord, type LogRecord } from './logger';
import { writeFatal } from './logger-sink';
import { normalizeProcessFailureReason } from './process-failure-reason';

/**
 * The only slice of `Crowi` the graceful shutdown path is allowed to touch
 * — RFC-0025 process-boundary D-P5/D-P1. Mechanically excludes
 * `bootReporter`: this handler never disposes it (a second SIGINT/SIGTERM
 * arriving while a disposer write is in flight must not be swallowed by a
 * reporter-teardown guard — see `createShutdownHandler`'s doc comment).
 */
export type ShutdownCrowi = Pick<Crowi, 'collabAttachment' | 'presenceAttachment' | 'notificationsAttachment'>;

type AttachmentName = 'collabAttachment' | 'presenceAttachment' | 'notificationsAttachment';

/** Snapshot order for `createShutdownHandler` — D-P5 fixes this as the attempt order. */
const ATTACHMENT_ORDER: readonly AttachmentName[] = ['collabAttachment', 'presenceAttachment', 'notificationsAttachment'];

/** D-P2 fixed epoch for every reduced record — never `new Date()`, since deriving it must not touch a timestamp formatter that may itself be the fault. */
const REDUCED_TIMESTAMP = '1970-01-01T00:00:00.000Z';

/**
 * D-P2 — one reduced record, built ONLY from a reason string already
 * derived (execution-free) before this call. Never reads the original
 * failure value, the request scope, or a timestamp formatter.
 */
function reducedFatalRecord(namespace: string, message: string, reason: string): LogRecord {
  return {
    timestamp: REDUCED_TIMESTAMP,
    level: 'error',
    namespace,
    message,
    data: { reduced: true, reason },
  };
}

/**
 * D-P2/D-P7 — module-level `crowi:shutdown` logger, constructed exactly
 * once per module evaluation. Per Phase 1 contract `createLogger` itself
 * never resolves `LOG_LEVEL`; only the first admitted call does, so this
 * module-level construction cannot observe a still-unloaded `.env`. Not
 * exported — this module's public surface is exactly `ShutdownCrowi`,
 * `createShutdownHandler`, and `installProcessFatalHandlers` (see the
 * "契約・不変条件" section of the spec this implements); a test observes
 * this logger's calls by mocking `./logger`'s `createLogger` before
 * requiring this module fresh, not by importing this binding.
 */
const shutdownLogger = createLogger('crowi:shutdown');

let fatalHandlersInstalled = false;

/**
 * D-P1/D-P3 — idempotent installer for the two Node process-fatal
 * listeners (`uncaughtException`, `unhandledRejection`). Each listener:
 *   1. derives a bounded, execution-free reason from the original value
 *      BEFORE touching it further, and builds the event-specific reduced
 *      record from that reason alone;
 *   2. tries the Phase 1 record factory exactly once with the ORIGINAL
 *      value (never re-derived), inside a `try`/`catch` that swallows a
 *      factory failure and keeps the reduced record — never rethrows;
 *   3. hands the chosen record to `writeFatal` from a `finally`, so a
 *      factory failure can never skip the handoff.
 * `writeFatal` never returns (`RecordSink#writeFatal(): never`) — neither
 * listener has a `never` return annotation of its own (current TypeScript
 * cannot infer non-local control flow through an arbitrary function call,
 * so annotating one here would be an unreachable-end-point/assignability
 * error at every call site that does not itself terminate).
 */
export function installProcessFatalHandlers(): void {
  if (fatalHandlersInstalled) return;
  fatalHandlersInstalled = true;

  process.on('uncaughtException', (error: unknown, origin: NodeJS.UncaughtExceptionOrigin): void => {
    const reason = normalizeProcessFailureReason(error);
    let record: LogRecord = reducedFatalRecord('crowi:process', 'uncaught exception', reason);
    try {
      record = createLogRecord('error', 'crowi:process', 'uncaught exception', { error, origin });
    } catch {
      // Factory failure keeps the reduced record derived above — the
      // original `error` is never read a second time.
    } finally {
      writeFatal(record);
    }
  });

  process.on('unhandledRejection', (reason: unknown, _promise: Promise<unknown>): void => {
    const normalizedReason = normalizeProcessFailureReason(reason);
    let record: LogRecord = reducedFatalRecord('crowi:process', 'unhandled rejection', normalizedReason);
    try {
      // `reason` — never the `promise` Node also passes — is the only
      // rejection payload E-P3's `data.error` carries (D-P2).
      record = createLogRecord('error', 'crowi:process', 'unhandled rejection', { error: reason });
    } catch {
      // See the `uncaughtException` listener above.
    } finally {
      writeFatal(record);
    }
  });
}

/**
 * D-P5/D-P1 — RFC-0003's graceful-shutdown handler, moved here from
 * `app.ts` alongside the entry-order rewrite. `shutdown()` flushes pending
 * Y.Doc checkpoints (via `collabAttachment.shutdown()`) before dropping
 * connections — without this hook, an unsaved-debounce window's worth of
 * edits would be lost on every process restart.
 *
 * `crowi: ShutdownCrowi` (not `Crowi`) mechanically excludes `bootReporter`
 * from what this handler can touch — it is never disposed here, on
 * purpose: a second `SIGINT`/`SIGTERM` arriving while a disposer write is
 * still in flight must keep being handled by the shared one-shot handler
 * below, not get swallowed behind a reporter-teardown guard.
 *
 * The returned handler yields once, unconditionally, right after offering
 * the receipt record and snapshotting the three attachment fields — even
 * when the snapshot is all-`null` — so a signal handler registered by
 * something else for the SAME signal gets a chance to start its own
 * synchronous dispatch before this handler's attachment work begins. That
 * yield is not a normal-sink delivery barrier: nothing here waits for the
 * receipt record (or a per-attachment failure record) to physically reach
 * its stream before moving on, so on a boot-time all-`null` snapshot, or
 * after the LAST attempted attachment, the corresponding record can still
 * be unflushed when `exit` runs.
 */
export function createShutdownHandler(crowi: ShutdownCrowi, exit?: (code: number) => void): (signal: NodeJS.Signals) => Promise<void> {
  let shuttingDown = false;

  return async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    // Synchronous, pre-await snapshot (D-P5) — fixes both the one-shot
    // guard and which attachments this invocation will attempt before any
    // `await` runs, so a field wired in later (or nulled by a subsequent
    // shutdown) can never change what THIS invocation attempts.
    const snapshot: ReadonlyArray<readonly [AttachmentName, { shutdown(): Promise<void> } | null]> = ATTACHMENT_ORDER.map(
      (name) => [name, crowi[name]] as const,
    );

    shutdownLogger.info('shutdown signal received', { signal });

    // Unconditional single yield — see this function's doc comment.
    await Promise.resolve();

    for (const [name, attachment] of snapshot) {
      if (attachment === null) continue;
      try {
        await attachment.shutdown();
      } catch (err) {
        // Raw rejection value, unchanged, straight into `Logger.error`'s
        // `error` argument — Phase 1's bounded Error normalization owns
        // turning it into safe output; bounding it again here would drop
        // the stack/`cause` detail this failure needs (D-P5).
        shutdownLogger.error('attachment shutdown failed', err, { attachment: name });
      }
    }

    // Resolved HERE (not captured at `createShutdownHandler` call time) so
    // a `process.exit` stub installed any time before this line runs is
    // honoured.
    (exit ?? ((code: number) => process.exit(code)))(0);
  };
}
