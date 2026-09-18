import { types } from 'node:util';

/**
 * Fixed fallback for any input shape this module does not admit — RFC-0025
 * process-boundary contract D-P2. Never interpolated with the original
 * value; the whole point of this literal is to describe a failure whose
 * *shape itself* could not be trusted enough to read.
 */
const UNKNOWN_PROCESS_FAILURE = 'unknown process failure';

/** First-line / length cap — D-P2. Bounded work regardless of input size. */
const MAX_REASON_LENGTH = 200;

/**
 * `number`/`boolean` primitives coerce through `String()` safely — this is
 * the engine's built-in primitive-to-string conversion, not `Symbol.
 * toPrimitive`/`toString()` object coercion (which only applies to objects
 * and is what this module deliberately avoids for everything else).
 */
function primitiveCandidate(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/**
 * `util.types.isNativeError` classifies by an internal engine tag, not by
 * walking the prototype chain (`instanceof` semantics) — verified against a
 * `Proxy` with a throwing `getPrototypeOf` trap, which this returns `false`
 * for without ever invoking the trap (D-P2 R-R6). Once classified as a
 * native Error, only an OWN, DATA `message` descriptor is read (`'value' in
 * descriptor`, never `.get`) — an inherited or accessor `message` (R-R7/R-R8)
 * is rejected without invoking anything.
 */
function nativeErrorCandidate(value: unknown): string | undefined {
  if (!types.isNativeError(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'message');
  if (descriptor === undefined || !('value' in descriptor)) return undefined;
  return typeof descriptor.value === 'string' ? descriptor.value : undefined;
}

/**
 * Collapse an arbitrary thrown/rejected value into a bounded, single-line
 * reason string without executing or coercing any of the caller's object
 * machinery (getters, `Symbol.toPrimitive`, `toString()`, prototype-chain
 * traps) — RFC-0025 process-boundary D-P2/D-P4. Shared by the marker
 * derivation (`crowi/index.ts`'s `exitOnError`) and the fatal-record reduced
 * path (`process-boundary.ts`); NOT used by `util/boot-reporter.ts`'s
 * `formatBootFailureReason`, which keeps a different, execution-capable
 * contract for the ordinary (non-fatal-path) boot marker — see that
 * function's doc comment for why the two do not merge.
 *
 * Bounded work: the candidate string is sliced to {@link MAX_REASON_LENGTH}
 * code units FIRST, and the first-line search runs only inside that bounded
 * slice — never `String.prototype.split` on the whole input, so a
 * newline-dense multi-megabyte string costs the same as a short one.
 */
export function normalizeProcessFailureReason(err: unknown): string {
  const candidate = primitiveCandidate(err) ?? nativeErrorCandidate(err);
  if (candidate === undefined) return UNKNOWN_PROCESS_FAILURE;
  const bounded = candidate.slice(0, MAX_REASON_LENGTH);
  const newlineIndex = bounded.indexOf('\n');
  return newlineIndex === -1 ? bounded : bounded.slice(0, newlineIndex);
}
