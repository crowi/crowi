import type Crowi from 'src/crowi';
import { createLogger, createLogRecord, type LogData, type LogRecord } from './logger';
import { writeFatal } from './logger-sink';
import { normalizeProcessFailureReason } from './process-failure-reason';

/**
 * The only slice of `Crowi` the graceful shutdown path is allowed to touch.
 * Mechanically excludes `bootReporter`: this handler never disposes it (a
 * second SIGINT/SIGTERM arriving while a disposer write is in flight must
 * not be swallowed by a reporter-teardown guard — see
 * `createShutdownHandler`'s doc comment).
 */
export type ShutdownCrowi = Pick<Crowi, 'collabAttachment' | 'presenceAttachment' | 'notificationsAttachment'>;

type AttachmentName = keyof ShutdownCrowi;

/** Snapshot order for `createShutdownHandler`, which is also its attempt order. */
const ATTACHMENT_ORDER: readonly AttachmentName[] = ['collabAttachment', 'presenceAttachment', 'notificationsAttachment'];

/** Fixed epoch for every reduced record — never `new Date()`, since deriving it must not touch a timestamp formatter that may itself be the fault. */
const REDUCED_TIMESTAMP = '1970-01-01T00:00:00.000Z';

/**
 * One reduced record, built ONLY from a reason string already derived
 * (execution-free) before this call. Never reads the original failure
 * value, the request scope, or a timestamp formatter.
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
 * `createLogger` never resolves `LOG_LEVEL` at construction — only the
 * first admitted call does — so this module-level construction cannot
 * observe a still-unloaded `.env`.
 */
const shutdownLogger = createLogger('crowi:shutdown');

let fatalHandlersInstalled = false;

/**
 * Shared body of both process-fatal listeners. The bounded reason is
 * derived from the original value BEFORE anything else touches it, so the
 * reduced record never depends on that value's own machinery. The record
 * factory is then tried exactly once with the ORIGINAL value, and
 * `writeFatal` runs from `finally` so a factory failure can never skip the
 * handoff.
 *
 * `writeFatal` never returns (`RecordSink#writeFatal(): never`) — neither
 * this function nor either listener has a `never` return annotation of its
 * own (current TypeScript cannot infer non-local control flow through an
 * arbitrary function call, so annotating one here would be an
 * unreachable-end-point/assignability error at every call site that does
 * not itself terminate).
 */
function handOffFatal(message: string, original: unknown, data: LogData): void {
  const reason = normalizeProcessFailureReason(original);
  let record: LogRecord = reducedFatalRecord('crowi:process', message, reason);
  try {
    record = createLogRecord('error', 'crowi:process', message, data);
  } catch {
    // Factory failure keeps the reduced record derived above — the
    // original value is never read a second time.
  } finally {
    writeFatal(record);
  }
}

/** Idempotent installer for the two Node process-fatal listeners (`uncaughtException`, `unhandledRejection`). */
export function installProcessFatalHandlers(): void {
  if (fatalHandlersInstalled) return;
  fatalHandlersInstalled = true;

  process.on('uncaughtException', (error: unknown, origin: NodeJS.UncaughtExceptionOrigin): void => {
    handOffFatal('uncaught exception', error, { error, origin });
  });

  process.on('unhandledRejection', (reason: unknown, _promise: Promise<unknown>): void => {
    // Only `reason` — never the `promise` Node also passes — goes into the
    // record's `data.error`.
    handOffFatal('unhandled rejection', reason, { error: reason });
  });
}

/**
 * RFC-0003's graceful-shutdown handler. `shutdown()` flushes pending
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

    // Synchronous, pre-await snapshot — fixes both the one-shot guard and
    // which attachments this invocation will attempt before any `await`
    // runs, so a field wired in later (or nulled by a subsequent shutdown)
    // can never change what THIS invocation attempts.
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
        // `error` argument — the logger's bounded Error normalization owns
        // turning it into safe output; bounding it again here would drop
        // the stack/`cause` detail this failure needs.
        shutdownLogger.error('attachment shutdown failed', err, { attachment: name });
      }
    }

    // Resolved HERE (not captured at `createShutdownHandler` call time) so
    // a `process.exit` stub installed any time before this line runs is
    // honoured.
    (exit ?? ((code: number) => process.exit(code)))(0);
  };
}
