/**
 * Bridge for the different `Buffer`-shaped values Mongoose returns
 * depending on the read mode:
 *
 *   - `.find(...).exec()` — `payload` arrives as a Mongoose `Buffer`
 *     (which extends Node's `Buffer`). `new Uint8Array(buffer)`
 *     correctly views the same bytes.
 *
 *   - `.find(...).lean().exec()` — `payload` arrives as a bson
 *     `Binary` instance. The actual bytes live on `binary.buffer`
 *     (a Node `Buffer`), not on the `Binary` instance itself. Passing
 *     the `Binary` directly to `new Uint8Array(...)` reads numeric
 *     prototype keys instead of bytes, which materializes as
 *     "Unexpected end of array" deep inside Y.applyUpdate.
 *
 * Centralising the normalization here keeps the hooks
 * payload-shape-agnostic. We deliberately accept `unknown` so the
 * caller's Mongoose-`any` plumbing doesn't have to import any bson
 * types.
 */
export function payloadToUint8Array(payload: unknown): Uint8Array {
  if (payload == null) {
    return new Uint8Array();
  }
  // Plain Node Buffer (or Mongoose's Buffer subclass) — fast path.
  if (Buffer.isBuffer(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  // bson `Binary` — exposes a Node Buffer on `.buffer`.
  if (typeof payload === 'object' && payload !== null && 'buffer' in payload) {
    const inner = (payload as { buffer: unknown }).buffer;
    if (Buffer.isBuffer(inner)) {
      return new Uint8Array(inner.buffer, inner.byteOffset, inner.byteLength);
    }
    if (inner instanceof Uint8Array) {
      return inner;
    }
  }
  // Already a Uint8Array (e.g. someone hand-built one in a test).
  if (payload instanceof Uint8Array) {
    return payload;
  }
  throw new TypeError(`Unsupported Yjs payload shape: ${Object.prototype.toString.call(payload)}`);
}
