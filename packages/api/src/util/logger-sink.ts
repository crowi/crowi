import fs from 'node:fs';
import type { LogRecord } from './logger';
import { createRecordSink, type RecordSink } from './logger-sink-runtime';

/**
 * Lazily constructed and memoized on first use (brief §5.5). Import alone
 * must not create the runtime, attach a stream listener, or schedule a
 * timer — a CLI, a migration, or a test importing this module never writes
 * through it and must not inherit listeners on shared process streams, and
 * eager construction at import would capture `process.stderr.fd` before a
 * host has finished redirecting descriptors.
 */
let memoized: RecordSink | undefined;

function getSink(): RecordSink {
  if (memoized === undefined) {
    memoized = createRecordSink({
      stdout: process.stdout,
      stderr: process.stderr,
      stderrFd: process.stderr.fd,
      writeSync: fs.writeSync,
      exit: (code: number) => process.exit(code),
      now: () => performance.now(),
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
  }
  return memoized;
}

// `write` and `writeFatal` resolve to the SAME memoized instance — a fatal
// record must never construct a second sink, which would attach fresh
// listeners while the process is terminating.
export const write = (record: LogRecord): void => getSink().write(record);

export const writeFatal = (record: LogRecord): never => getSink().writeFatal(record);
