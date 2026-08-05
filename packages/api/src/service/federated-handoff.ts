/**
 * RFC-0014 phase 1 §"設計の主な判断" 4 — the federated sign-in handoff code
 * store: `{ codeHash, userId, handoffJkt }`, 30-second TTL, exactly-once
 * atomic consume.
 *
 * The store itself never verifies anything — `find()` is a read-only
 * lookup the caller uses to check the JKT/ES256 proof BEFORE calling
 * `consumeVerified()`. `consumeVerified()` is safe to call unconditionally
 * (its own atomicity is what actually enforces "at most one caller wins"),
 * but callers MUST have already verified the proof first — an unverified
 * consume would let ANY holder of the plaintext code (which travels over
 * `GET /login/complete?code=...`, i.e. a URL, i.e. a bearer capability by
 * itself) redeem it. See `hono/handlers/federated-auth.ts`'s handoff
 * handler for the required call order.
 *
 * `find()` deliberately returns the record REGARDLESS of whether it has
 * already been consumed — this is what lets the handler tell apart a code
 * that never existed / expired (`find()` → `null` → 401) from a code whose
 * VALID proof is presented again after a successful consume (`find()` →
 * record, JKT/signature still verify, `consumeVerified()` → `null` → 409 —
 * RFC-0014 phase 1 §"契約・不変条件": "正当 proof 後の再利用は409"). A design
 * that instead DELETED the record on first consume could not make this
 * distinction (a deleted key is indistinguishable from one that never
 * existed), so the record's underlying storage outlives a successful
 * consume and only ever disappears via its normal TTL.
 *
 * Two backends, same interface:
 *   - Redis (multi-instance): the record itself is a plain `SET ... PX`
 *     (never deleted by `consumeVerified`); the exactly-once gate is a
 *     SIBLING key, atomically checked-and-set alongside the record read by
 *     a single `EVAL` script (see below) — only the FIRST caller to land
 *     wins.
 *   - No Redis (single instance / dev): a plain in-memory `Map`, one entry
 *     per code, carrying a `consumedAt` field. `consumeVerified()`'s
 *     check-then-mark never `await`s in between, so no other async task can
 *     interleave (Node's single-threaded event loop only switches tasks at
 *     an `await`/microtask boundary) — that is what makes a plain `Map` an
 *     adequate "process-local mutex" here, no separate lock primitive
 *     needed.
 *
 * Redis TTL / in-memory `expiresAt` both enforce the 30s window on BOTH the
 * record and the consumed-marker; the in-memory store additionally sweeps
 * expired entries opportunistically.
 *
 * Redis `consumeVerified()` runs a single `EVAL` script rather than a
 * separate `GET` + `SET NX` — two separate round trips would leave a race
 * window where the record's own TTL could expire BETWEEN them while the
 * stale value read by the `GET` is still treated as live, letting a caller
 * redeem past the 30-second window. A Lua script executes atomically
 * server-side (no other command, including passive TTL expiry, can
 * interleave mid-script), so the liveness check and the exactly-once mark
 * happen as one indivisible operation.
 *
 * Storage-layer errors (a dead Redis connection, a script eval failure,
 * ...) are NEVER swallowed to `null` here — that would make a backend
 * outage indistinguishable from "code never existed" (401) or "already
 * consumed" (409), both of which are wrong: an unexpected failure must
 * surface as the caller's generic 500 (`hono/handlers/federated-auth.ts`'s
 * `/handoff` route already wraps this store's calls in a try/catch that
 * maps any thrown error to `INTERNAL_ERROR_BODY`/500).
 */
import crypto from 'node:crypto';

import type { RedisKeyspace } from 'src/util/redis-keyspace';

/** RFC-0014 phase 1 §"契約・不変条件" — handoff code TTL. */
const HANDOFF_TTL_MS = 30 * 1000;

const CODE_BYTES = 32;

export interface FederatedHandoffRecord {
  userId: string;
  /** RFC 7638 JWK thumbprint the eventual `/handoff` proof's public key must match. */
  handoffJkt: string;
}

/**
 * `consumeVerified()`'s outcome. The two failure `reason`s are NOT
 * interchangeable: `not_found` covers both "code never existed" and "code
 * expired" (indistinguishable from each other by design — TTL expiry IS
 * the record disappearing), while `already_consumed` means a DIFFERENT,
 * still-live caller already won the atomic consume. Collapsing the two
 * into one bit would make a code that merely expired between the caller's
 * `find()` and `consumeVerified()` calls (proof verification takes real
 * time, so this window is not academic) indistinguishable from a genuine
 * replay/race — the handler maps `not_found` to 401 (same as `find()`
 * returning `null`) and `already_consumed` to 409, and getting this wrong
 * falsely tells a caller "someone already used your code" when in fact
 * nobody did.
 */
export type FederatedHandoffConsumeOutcome =
  | { readonly ok: true; readonly record: FederatedHandoffRecord }
  | { readonly ok: false; readonly reason: 'not_found' | 'already_consumed' };

export interface FederatedHandoffStore {
  /** Issue a fresh handoff code bound to `userId`/`handoffJkt`. Returns the plaintext code — never persisted, only its SHA-256 hash is stored. */
  issue(userId: string, handoffJkt: string): Promise<string>;
  /** Read-only lookup by plaintext code. Does NOT consume, and does NOT distinguish "never existed" from "already consumed" — see the module doc comment. `null` when absent/expired. */
  find(code: string): Promise<FederatedHandoffRecord | null>;
  /**
   * Atomically consume the record for `code`. Idempotent-safe: only the
   * FIRST caller for a given code receives `{ ok: true, record }`; every
   * later caller (a legitimate double-send, or a racing attacker) receives
   * `{ ok: false, reason: 'already_consumed' }` — vs. a code that was never
   * issued, or that expired (including between this caller's own `find()`
   * and this call), which receives `{ ok: false, reason: 'not_found' }`.
   * See `FederatedHandoffConsumeOutcome`'s doc comment for why these two
   * failure reasons must stay distinct.
   */
  consumeVerified(code: string): Promise<FederatedHandoffConsumeOutcome>;
}

/**
 * Minimum surface of a node-redis v4 client this store leans on. Narrow by
 * design (same convention as `util/editor-cap-counter.ts`'s
 * `MinimalRedisClient`) — keeps the test mock surface small.
 */
export interface MinimalRedisClient {
  set(key: string, value: string, options: { PX: number; NX?: true }): Promise<unknown>;
  get(key: string): Promise<string | null>;
  /**
   * Used ONLY by `consumeVerified()`'s atomic check-and-mark script — see
   * the module doc comment for why a separate `GET` + `SET NX` cannot
   * substitute for this. `keys`/`arguments` mirror node-redis v4's
   * `EvalOptions` shape.
   */
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function serializeRecord(record: FederatedHandoffRecord): string {
  return JSON.stringify(record);
}

function parseRecord(raw: string | null | undefined): FederatedHandoffRecord | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FederatedHandoffRecord>;
    if (typeof parsed.userId !== 'string' || typeof parsed.handoffJkt !== 'string') return null;
    return { userId: parsed.userId, handoffJkt: parsed.handoffJkt };
  } catch {
    return null;
  }
}

/**
 * Atomic check-and-mark: `GET` the record, then (only if present) `SET ...
 * NX` the sibling consumed-marker — both as ONE Lua script so Redis can
 * never expire the record between the two steps (see the module doc
 * comment). The two failure paths return DISTINCT sentinel strings
 * (`NOT_FOUND` / `ALREADY_CONSUMED`) rather than both collapsing to Lua
 * `false` — a real stored record is always `JSON.stringify({userId,
 * handoffJkt, ...})`, which can never equal either sentinel, so there is
 * no ambiguity between a sentinel and a genuine record value. A present,
 * unconsumed record returns the raw JSON string as a Lua string (RESP
 * Bulk reply) same as before.
 */
const CONSUME_SCRIPT = `
local record = redis.call('GET', KEYS[1])
if record == false then
  return 'NOT_FOUND'
end
local marked = redis.call('SET', KEYS[2], '1', 'NX', 'PX', ARGV[1])
if not marked then
  return 'ALREADY_CONSUMED'
end
return record
`;

function createRedisHandoffStore(client: MinimalRedisClient, keyspace: RedisKeyspace): FederatedHandoffStore {
  const keyFor = (code: string) => keyspace.key('federated-handoff', hashCode(code));
  const consumedKeyFor = (code: string) => keyspace.key('federated-handoff-consumed', hashCode(code));

  return {
    async issue(userId, handoffJkt) {
      const code = crypto.randomBytes(CODE_BYTES).toString('base64url');
      await client.set(keyFor(code), serializeRecord({ userId, handoffJkt }), { PX: HANDOFF_TTL_MS });
      return code;
    },
    async find(code) {
      return parseRecord(await client.get(keyFor(code)));
    },
    async consumeVerified(code) {
      const reply = await client.eval(CONSUME_SCRIPT, {
        keys: [keyFor(code), consumedKeyFor(code)],
        arguments: [String(HANDOFF_TTL_MS)],
      });
      if (reply === 'NOT_FOUND') return { ok: false, reason: 'not_found' };
      if (reply === 'ALREADY_CONSUMED') return { ok: false, reason: 'already_consumed' };
      const record = typeof reply === 'string' ? parseRecord(reply) : null;
      // A malformed stored value (shouldn't happen — this store is the only
      // writer) is indistinguishable from "gone" to a caller, not a replay.
      if (!record) return { ok: false, reason: 'not_found' };
      return { ok: true, record };
    },
  };
}

interface MemoryEntry extends FederatedHandoffRecord {
  expiresAt: number;
  consumedAt: number | null;
}

function createInMemoryHandoffStore(): FederatedHandoffStore {
  const store = new Map<string, MemoryEntry>();

  const sweepExpired = (now: number): void => {
    for (const [key, entry] of store) {
      if (entry.expiresAt <= now) store.delete(key);
    }
  };

  return {
    async issue(userId, handoffJkt) {
      const code = crypto.randomBytes(CODE_BYTES).toString('base64url');
      const now = Date.now();
      sweepExpired(now);
      store.set(hashCode(code), { userId, handoffJkt, expiresAt: now + HANDOFF_TTL_MS, consumedAt: null });
      return code;
    },
    async find(code) {
      const entry = store.get(hashCode(code));
      if (!entry || entry.expiresAt <= Date.now()) return null;
      return { userId: entry.userId, handoffJkt: entry.handoffJkt };
    },
    async consumeVerified(code) {
      const key = hashCode(code);
      // Synchronous check-then-mark — see the module doc comment.
      const entry = store.get(key);
      if (!entry || entry.expiresAt <= Date.now()) return { ok: false, reason: 'not_found' };
      if (entry.consumedAt != null) return { ok: false, reason: 'already_consumed' };
      entry.consumedAt = Date.now();
      return { ok: true, record: { userId: entry.userId, handoffJkt: entry.handoffJkt } };
    },
  };
}

export interface CreateFederatedHandoffStoreOptions {
  /** Pass `crowi.redis`. `null`/`undefined` → in-memory fallback. */
  redisClient?: MinimalRedisClient | null;
  /** MANDATORY whenever `redisClient` is supplied (same convention as `util/editor-cap-counter.ts` / `util/rate-limit.ts`). */
  keyspace?: RedisKeyspace;
}

export function createFederatedHandoffStore(options: CreateFederatedHandoffStoreOptions = {}): FederatedHandoffStore {
  if (options.redisClient) {
    if (!options.keyspace) {
      throw new Error(
        'createFederatedHandoffStore: `keyspace` is required whenever `redisClient` is supplied (feature-redis-key-prefix §1/§2) — ' +
          'resolve one via resolveRedisKeyspaceIfEnabled(crowi) before constructing the store.',
      );
    }
    return createRedisHandoffStore(options.redisClient, options.keyspace);
  }
  return createInMemoryHandoffStore();
}
