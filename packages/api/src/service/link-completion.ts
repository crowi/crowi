/**
 * The account-link completion store:
 * `POST link-start` mints a signed `FederatedLinkState` cookie; the IdP
 * callback verifies it and calls `issue()` to mint a one-time completion
 * `code`; the authenticated confirmation GET/POST read/consume it via
 * `find()`/`consumeVerified()`.
 *
 * Deliberately NOT built on top of `federated-handoff.ts`'s store (despite
 * the structural resemblance — record + sibling consume marker): this store
 * idempotizes `issue()` itself (keyed
 * by the OAuth `state`, so a duplicate/racing callback for the same state
 * can never mint a second code), tracks THREE independent expiries (state /
 * authorization / consumed-retention) instead of one, and extends the
 * record's TTL on a successful consume (5-minute replay window) instead of
 * leaving it immutable. Squashing both into one shared abstraction would
 * make each store's simpler contract carry the other's complexity for no
 * shared behaviour.
 *
 * Clock: the Redis backend NEVER reads the local process's `Date.now()` for
 * any deadline decision. `issue()` and `consumeVerified()` each call
 * `redis.call('TIME')` ATOMICALLY INSIDE their own Lua script — not a
 * separate `MinimalLinkCompletionRedisClient#time()` round trip beforehand
 * — because the state/authorization deadline check and the mutating
 * `SET`/`SET NX` it gates must observe the SAME instant; a network delay
 * between a JS-side `time()` call and a later `EVAL` could otherwise let a
 * code get issued (or a consume land) on the wrong side of its own
 * deadline. `find()` — a non-destructive read with nothing to linearize
 * against — still asks the JS-level `MinimalLinkCompletionRedisClient
 * #time()` (the real `TIME` command, fetched immediately before comparing).
 * `link-start`'s signed `stateExpiresAt` and `issue()`'s state-deadline
 * check can be evaluated on DIFFERENT api replicas (any replica can serve
 * the callback), and per-replica process clocks are not guaranteed to
 * agree — Redis's own server clock is the one value every replica can
 * agree on. The in-memory (Map) backend has no cross-replica concern (a
 * single process owns the whole flow, and there is no network round trip
 * between reading the clock and mutating its own `Map`s), so it uses
 * `Date.now()` by default; `options.now` exists SOLELY so tests can pin
 * that clock deterministically — it is never read by the Redis backend.
 *
 * `issue()`'s atomicity (at most one winner per OAuth `state`) and
 * `consumeVerified()`'s atomicity (at most one winner per `code`) are each a
 * single Redis `EVAL` (Map: a synchronous check-then-mark with no `await` in
 * between — see `federated-handoff.ts`'s doc comment for why that is
 * sufficient on Node's single-threaded event loop). `consumeVerified()`'s
 * script checks "already consumed" (the sibling marker) BEFORE fetching
 * `TIME` and checking the authorization deadline, so a winner who consumes
 * microseconds before the 300s deadline still leaves any racing loser
 * `already_consumed` — even once the original authorization window has
 * technically elapsed — because the successful consume already re-armed
 * both keys' TTL to the 5-minute retention window before that could happen.
 */
import crypto from 'node:crypto';

import type { RedisKeyspace } from 'src/util/redis-keyspace';

/** code authorization window, from `issue()`'s linearization point. */
export const LINK_COMPLETION_AUTHORIZATION_TTL_MS = 300_000;

/** how long a CONSUMED record/marker survive, from `consumeVerified()`'s linearization point (covers the web client's unified retry window). */
export const LINK_COMPLETION_CONSUMED_RETENTION_MS = 5 * 60_000;

/** 32 random bytes -> 43-char base64url, matching the contract's `LinkCompletionCodeSchema` (`/^[A-Za-z0-9_-]{43}$/`). */
export const LINK_COMPLETION_CODE_BYTES = 32;

/**
 * Ceiling used
 * SOLELY to decide whether the optional `accountLabel` (an unbounded
 * display-only `profile.email`) is included in the stored record. Mandatory
 * fields (including the plugin-contract-unbounded `providerUserId`) are
 * NEVER checked against this ceiling and are always stored in full — see
 * the module doc comment and `buildRecordWithinBudget`.
 */
export const MAX_LINK_COMPLETION_RECORD_BYTES = 4096;

/** Input to `issue()` — everything the callback handler resolved from the verified `FederatedLinkState` cookie + the verified IdP profile. */
export interface LinkCompletionIssue {
  state: string;
  stateExpiresAt: number;
  userId: string;
  authVersion: number;
  provider: string;
  providerUserId: string;
  /** Display-only, optional, unbounded (`profile.email`) — see `MAX_LINK_COMPLETION_RECORD_BYTES`. */
  accountLabel?: string;
}

/** What `issue()`/`find()`/`consumeVerified()` return — the durable shape a completion code resolves to. */
export interface LinkCompletionRecord {
  userId: string;
  authVersion: number;
  provider: string;
  providerUserId: string;
  accountLabel?: string;
  issuedAt: number;
  authorizationExpiresAt: number;
  consumedAt: number | null;
  retentionExpiresAt: number | null;
}

/**
 * `state_already_issued` — a second (racing or later) `issue()` call for the
 * SAME OAuth `state` after the first winner already minted a code. The
 * loser never learns the winner's code (design decision 10) — it simply
 * fails, and the caller redirects to the generic link-failure page.
 *
 * `state_expired` — `now >= stateExpiresAt` at the linearization point,
 * regardless of whether the state marker is still present. A late retry
 * that lands after the state's own 300s window can never open a fresh code
 * window (design decision 3, §6).
 */
export type LinkCompletionIssueOutcome =
  | { readonly ok: true; readonly code: string; readonly record: LinkCompletionRecord }
  | { readonly ok: false; readonly reason: 'state_already_issued' | 'state_expired' };

/**
 * `not_found` — code never issued, OR unconsumed and past
 * `authorizationExpiresAt`, OR past its consumed `retentionExpiresAt` (the
 * storage layer no longer has a live entry at all in that last case; the
 * first two are an explicit field comparison at the linearization point,
 * not just physical storage absence — see the module doc comment).
 *
 * `already_consumed` — a DIFFERENT, still-retained winner already consumed
 * this code. See the module doc comment for the consumed-before-expiry
 * check ordering this depends on.
 */
export type LinkCompletionConsumeOutcome =
  | { readonly ok: true; readonly record: LinkCompletionRecord }
  | { readonly ok: false; readonly reason: 'not_found' | 'already_consumed' };

/** The store's entire public surface — deliberately only these three methods (out of scope: any cap/lease/resume/ZSET method). */
export interface LinkCompletionStore {
  /** Idempotent per `input.state` — see `LinkCompletionIssueOutcome`'s doc comment. */
  issue(input: LinkCompletionIssue): Promise<LinkCompletionIssueOutcome>;
  /** Non-destructive; returns a CONSUMED record too (until its retention TTL), so callers can tell "consumed" apart from "never existed / expired" (`null`). */
  find(code: string): Promise<LinkCompletionRecord | null>;
  /** At most one caller ever receives `{ ok: true }` for a given code — see the module doc comment. */
  consumeVerified(code: string): Promise<LinkCompletionConsumeOutcome>;
}

/**
 * Minimum node-redis surface this store depends on. `time()` backs only
 * `find()`'s non-destructive liveness check — `issue()`/`consumeVerified()`
 * fetch `TIME` atomically INSIDE their own Lua scripts instead of calling
 * this method (see the module doc comment for why). The reply shape is
 * `[unixTimestamp, microseconds]`, both decimal strings — see
 * {@link msFromRedisTimeReply}.
 */
export interface MinimalLinkCompletionRedisClient {
  get(key: string): Promise<string | null>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  time(): Promise<RedisTimeReply>;
}

/** Shape of node-redis's `TIME` reply — `[unixTimestamp, microseconds]`, both decimal strings. */
export type RedisTimeReply = readonly [unixTimestamp: string, microseconds: string];

/** Converts a node-redis `TIME` reply to the epoch-ms number `find()` (and callers wiring their own `LinkCompletionRuntime#now()`, e.g. `federated-auth.ts`) need — shared so the tuple math lives in exactly one place. */
export function msFromRedisTimeReply(reply: RedisTimeReply): number {
  const [unixTimestamp, microseconds] = reply;
  // Matches ISSUE_SCRIPT / CONSUME_SCRIPT's own `math.floor(...)` derivation
  // of `now` from the same reply shape — a fractional value here would make
  // JS-side deadline comparisons (`find()`) disagree with the Lua-side ones.
  return Math.floor(Number(unixTimestamp) * 1000 + Number(microseconds) / 1000);
}

export interface CreateLinkCompletionStoreOptions {
  /** Pass `crowi.redis`. `null`/`undefined` -> in-memory fallback (unless `requireRedis`). */
  redisClient?: MinimalLinkCompletionRedisClient | null;
  /** MANDATORY whenever `redisClient` is supplied (feature-redis-key-prefix §1/§2 convention). */
  keyspace?: RedisKeyspace;
  /** When `true` and no `redisClient` is supplied, the factory throws instead of silently falling back to the in-memory store (multi-instance topologies must fail closed rather than silently losing shared state). */
  requireRedis?: boolean;
  /** In-memory backend ONLY — a test clock. Never consulted by the Redis backend (see the module doc comment). Defaults to `Date.now`. */
  now?: () => number;
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** The subset of {@link LinkCompletionRecord} `issue()` decides up front — everything EXCEPT the four time fields, which only the backend that owns the linearization point (Redis: atomically inside Lua via `TIME`; Map: the caller-supplied clock) may stamp. */
interface LinkCompletionRecordFields {
  userId: string;
  authVersion: number;
  provider: string;
  providerUserId: string;
  accountLabel?: string;
}

/**
 * `withLabel` decides whether `accountLabel` is included at all — kept
 * separate from "is `input.accountLabel` present" so `selectRecordFields`
 * can build the mandatory-only variant first, measure it, then decide.
 */
function buildRecordFields(input: LinkCompletionIssue, withLabel: boolean): LinkCompletionRecordFields {
  const fields: LinkCompletionRecordFields = {
    userId: input.userId,
    authVersion: input.authVersion,
    provider: input.provider,
    providerUserId: input.providerUserId,
  };
  if (withLabel && input.accountLabel !== undefined) {
    fields.accountLabel = input.accountLabel;
  }
  return fields;
}

/**
 * Fixed, representative 13-digit epoch-ms magnitude used SOLELY to measure
 * whether adding `accountLabel` would push the serialized record over
 * {@link MAX_LINK_COMPLETION_RECORD_BYTES} — never the actual stored value.
 * The real `issuedAt`/`authorizationExpiresAt` come from whichever backend
 * owns the linearization point (Redis: `redis.call('TIME')`, evaluated
 * atomically inside the Lua scripts below; Map: the caller's clock — see
 * the module doc comment). Any real epoch-ms timestamp keeps this exact
 * digit width (and `+ LINK_COMPLETION_AUTHORIZATION_TTL_MS` does too) until
 * year ~2286, so measuring against this constant instead of the call's
 * actual `now` produces an identical byte count.
 */
const RECORD_SIZE_ESTIMATION_TIMESTAMP_MS = 1_700_000_000_000;

function shadowRecordForSizeEstimate(fields: LinkCompletionRecordFields): LinkCompletionRecord {
  return {
    ...fields,
    issuedAt: RECORD_SIZE_ESTIMATION_TIMESTAMP_MS,
    authorizationExpiresAt: RECORD_SIZE_ESTIMATION_TIMESTAMP_MS + LINK_COMPLETION_AUTHORIZATION_TTL_MS,
    consumedAt: null,
    retentionExpiresAt: null,
  };
}

/**
 * Decide which fields `issue()` sends to the backend. The mandatory-fields-
 * only variant is ALWAYS what gets stored when adding `accountLabel` would
 * push the total over {@link MAX_LINK_COMPLETION_RECORD_BYTES}; the ceiling
 * is never applied to the mandatory fields themselves (an unbounded
 * `providerUserId` — already true of the shipped non-link callback path —
 * must never turn into a callback failure).
 */
function selectRecordFields(input: LinkCompletionIssue): LinkCompletionRecordFields {
  const withoutLabel = buildRecordFields(input, false);
  if (input.accountLabel === undefined) {
    return withoutLabel;
  }
  const withLabel = buildRecordFields(input, true);
  const estimatedBytes = byteLength(JSON.stringify(shadowRecordForSizeEstimate(withLabel)));
  return estimatedBytes <= MAX_LINK_COMPLETION_RECORD_BYTES ? withLabel : withoutLabel;
}

/** Map backend only — Redis stamps these atomically inside Lua instead (see the module doc comment). */
function finalizeRecord(fields: LinkCompletionRecordFields, now: number): LinkCompletionRecord {
  return {
    ...fields,
    issuedAt: now,
    authorizationExpiresAt: now + LINK_COMPLETION_AUTHORIZATION_TTL_MS,
    consumedAt: null,
    retentionExpiresAt: null,
  };
}

/**
 * `find()`'s liveness check — applied on TOP of physical storage presence
 * (Redis PX / the Map's own timer), never in place of it: an unconsumed
 * record is live only before `authorizationExpiresAt`; a consumed one is
 * live only before `retentionExpiresAt`. Explicit rather than physical-
 * removal-only because physical eviction (a Map `setTimeout`, or Redis's
 * own expiry sweep) is not guaranteed to have already run at the exact
 * millisecond boundary a caller's `now` observes — see the module doc
 * comment on `consumeVerified()`'s consumed-before-expiry ordering, which
 * this mirrors for reads.
 */
function isRecordLive(record: LinkCompletionRecord, now: number): boolean {
  if (record.consumedAt == null) {
    return now < record.authorizationExpiresAt;
  }
  return record.retentionExpiresAt != null && now < record.retentionExpiresAt;
}

function parseRecord(raw: string | null | undefined): LinkCompletionRecord | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LinkCompletionRecord>;
    if (
      typeof parsed.userId !== 'string' ||
      typeof parsed.authVersion !== 'number' ||
      typeof parsed.provider !== 'string' ||
      typeof parsed.providerUserId !== 'string' ||
      typeof parsed.issuedAt !== 'number' ||
      typeof parsed.authorizationExpiresAt !== 'number' ||
      (parsed.consumedAt !== null && typeof parsed.consumedAt !== 'number') ||
      (parsed.retentionExpiresAt !== null && typeof parsed.retentionExpiresAt !== 'number')
    ) {
      return null;
    }
    const record: LinkCompletionRecord = {
      userId: parsed.userId,
      authVersion: parsed.authVersion,
      provider: parsed.provider,
      providerUserId: parsed.providerUserId,
      issuedAt: parsed.issuedAt,
      authorizationExpiresAt: parsed.authorizationExpiresAt,
      consumedAt: parsed.consumedAt ?? null,
      retentionExpiresAt: parsed.retentionExpiresAt ?? null,
    };
    if (typeof parsed.accountLabel === 'string') {
      record.accountLabel = parsed.accountLabel;
    }
    return record;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Redis backend
// ---------------------------------------------------------------------------

/**
 * `KEYS[1]` = state marker key, `KEYS[2]` = record key.
 * `ARGV[1]` = `stateExpiresAt` (ms, the signed link-state's absolute
 * deadline), `ARGV[2]` = record fields JSON (mandatory fields, optionally
 * `accountLabel` — already budget-decided by `selectRecordFields`, but
 * WITHOUT any time field), `ARGV[3]` = authorization TTL (ms, always the
 * fixed {@link LINK_COMPLETION_AUTHORIZATION_TTL_MS}).
 *
 * `redis.call('TIME')` is the FIRST thing this script does, and every
 * decision after it — the state deadline check, the residual state-marker
 * TTL, and the record's `issuedAt`/`authorizationExpiresAt` — is derived
 * from that single atomic read. This must live INSIDE the script (not a
 * separate `TIME` round trip in JS before calling `EVAL`): a network delay
 * between a JS-side `time()` and this `EVAL` could otherwise let a state
 * that was still valid when JS checked it land on the wrong side of its own
 * deadline by the time the marker is actually set.
 *
 * `SET ... NX` on the state marker is the ONE atomic mutation decision this
 * script makes: exactly one caller across any number of concurrent/
 * sequential `issue()` calls for the same `state` observes `marked` truthy.
 * A state already past its deadline returns `STATE_EXPIRED` WITHOUT ever
 * attempting the marker `SET` — the same "never reaches the atomic marker
 * step" contract as before, just evaluated with the script's own `TIME`
 * instead of a value handed in by the caller.
 *
 * Returns the full serialized record (not `'OK'`) so the JS caller learns
 * the real, server-stamped `issuedAt`/`authorizationExpiresAt` — those
 * fields do not exist in `ARGV[2]`.
 */
const ISSUE_SCRIPT = `
local time = redis.call('TIME')
local now = math.floor(tonumber(time[1]) * 1000 + tonumber(time[2]) / 1000)
local stateExpiresAt = tonumber(ARGV[1])
if now >= stateExpiresAt then
  return 'STATE_EXPIRED'
end
local residualStateTtl = stateExpiresAt - now
if residualStateTtl < 1 then
  residualStateTtl = 1
end
local marked = redis.call('SET', KEYS[1], '1', 'NX', 'PX', string.format('%d', residualStateTtl))
if not marked then
  return 'STATE_ALREADY_ISSUED'
end
local authorizationTtl = tonumber(ARGV[3])
local record = cjson.decode(ARGV[2])
record.issuedAt = now
record.authorizationExpiresAt = now + authorizationTtl
record.consumedAt = cjson.null
record.retentionExpiresAt = cjson.null
local json = cjson.encode(record)
redis.call('SET', KEYS[2], json, 'PX', string.format('%d', authorizationTtl))
return json
`;

/**
 * `KEYS[1]` = record key, `KEYS[2]` = sibling consumed-marker key.
 * `ARGV[1]` = consumed retention TTL (ms, always
 * {@link LINK_COMPLETION_CONSUMED_RETENTION_MS}).
 *
 * Ordering matches the module doc comment: "already consumed" (the sibling
 * marker) is checked BEFORE `redis.call('TIME')` is even invoked, so a
 * winner who consumed microseconds before the 300s deadline still resolves
 * any racing loser to `ALREADY_CONSUMED` rather than `NOT_FOUND` — the
 * loser's own `TIME` read (which could be past the ORIGINAL deadline) never
 * gets a chance to matter. `TIME` itself is fetched INSIDE this script,
 * atomically with the deadline check and the winning `SET`s, for the exact
 * same reason as `ISSUE_SCRIPT` above: a JS-side `time()` call before this
 * `EVAL` could observe a different instant than the one the mutation
 * actually lands at.
 */
const CONSUME_SCRIPT = `
local recordRaw = redis.call('GET', KEYS[1])
if recordRaw == false then
  return 'NOT_FOUND'
end
local markerExists = redis.call('GET', KEYS[2])
if markerExists then
  return 'ALREADY_CONSUMED'
end
local time = redis.call('TIME')
local now = math.floor(tonumber(time[1]) * 1000 + tonumber(time[2]) / 1000)
local record = cjson.decode(recordRaw)
if now >= record.authorizationExpiresAt then
  return 'NOT_FOUND'
end
local retentionMs = tonumber(ARGV[1])
record.consumedAt = now
record.retentionExpiresAt = now + retentionMs
local updated = cjson.encode(record)
redis.call('SET', KEYS[1], updated, 'PX', string.format('%d', retentionMs))
redis.call('SET', KEYS[2], '1', 'PX', string.format('%d', retentionMs))
return updated
`;

function createRedisLinkCompletionStore(client: MinimalLinkCompletionRedisClient, keyspace: RedisKeyspace): LinkCompletionStore {
  const stateKeyFor = (state: string) => keyspace.key('link-completion-state', sha256Hex(state));
  const recordKeyFor = (code: string) => keyspace.key('link-completion-record', sha256Hex(code));
  const consumedKeyFor = (code: string) => keyspace.key('link-completion-consumed', sha256Hex(code));

  return {
    async issue(input) {
      const code = crypto.randomBytes(LINK_COMPLETION_CODE_BYTES).toString('base64url');
      const fields = selectRecordFields(input);

      const reply = await client.eval(ISSUE_SCRIPT, {
        keys: [stateKeyFor(input.state), recordKeyFor(code)],
        arguments: [String(input.stateExpiresAt), JSON.stringify(fields), String(LINK_COMPLETION_AUTHORIZATION_TTL_MS)],
      });
      if (reply === 'STATE_EXPIRED') {
        return { ok: false, reason: 'state_expired' };
      }
      if (reply === 'STATE_ALREADY_ISSUED') {
        return { ok: false, reason: 'state_already_issued' };
      }
      const record = typeof reply === 'string' ? parseRecord(reply) : null;
      if (!record) {
        throw new Error('createLinkCompletionStore: issue script returned an unparsable record');
      }
      return { ok: true, code, record };
    },

    async find(code) {
      const now = msFromRedisTimeReply(await client.time());
      const record = parseRecord(await client.get(recordKeyFor(code)));
      if (!record || !isRecordLive(record, now)) return null;
      return record;
    },

    async consumeVerified(code) {
      const reply = await client.eval(CONSUME_SCRIPT, {
        keys: [recordKeyFor(code), consumedKeyFor(code)],
        arguments: [String(LINK_COMPLETION_CONSUMED_RETENTION_MS)],
      });
      if (reply === 'NOT_FOUND') return { ok: false, reason: 'not_found' };
      if (reply === 'ALREADY_CONSUMED') return { ok: false, reason: 'already_consumed' };
      const record = typeof reply === 'string' ? parseRecord(reply) : null;
      if (!record) return { ok: false, reason: 'not_found' };
      return { ok: true, record };
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory (Map) backend — single-instance / dev fallback
// ---------------------------------------------------------------------------

interface MapRecordEntry {
  record: LinkCompletionRecord;
  timer: ReturnType<typeof setTimeout>;
}

function createInMemoryLinkCompletionStore(clock: () => number): LinkCompletionStore {
  const stateMarkers = new Map<string, ReturnType<typeof setTimeout>>();
  const records = new Map<string, MapRecordEntry>();

  const armTimer = (ms: number, onFire: () => void): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(onFire, ms);
    // Physical-eviction-only timer — never keeps the process alive.
    timer.unref?.();
    return timer;
  };

  return {
    async issue(input) {
      // Synchronous check-then-set (no `await` in between) — see the module
      // doc comment on why this is an adequate process-local mutex.
      const now = clock();
      if (now >= input.stateExpiresAt) {
        return { ok: false, reason: 'state_expired' };
      }

      const stateKey = sha256Hex(input.state);
      if (stateMarkers.has(stateKey)) {
        return { ok: false, reason: 'state_already_issued' };
      }

      const code = crypto.randomBytes(LINK_COMPLETION_CODE_BYTES).toString('base64url');
      const record = finalizeRecord(selectRecordFields(input), now);
      const residualStateTtlMs = Math.max(1, input.stateExpiresAt - now);

      stateMarkers.set(
        stateKey,
        armTimer(residualStateTtlMs, () => stateMarkers.delete(stateKey)),
      );
      const recordKey = sha256Hex(code);
      records.set(recordKey, {
        record,
        timer: armTimer(LINK_COMPLETION_AUTHORIZATION_TTL_MS, () => records.delete(recordKey)),
      });

      return { ok: true, code, record };
    },

    async find(code) {
      const now = clock();
      const entry = records.get(sha256Hex(code));
      if (!entry || !isRecordLive(entry.record, now)) return null;
      return entry.record;
    },

    async consumeVerified(code) {
      const now = clock();
      const key = sha256Hex(code);
      const entry = records.get(key);
      if (!entry) return { ok: false, reason: 'not_found' };
      if (entry.record.consumedAt != null) return { ok: false, reason: 'already_consumed' };
      if (now >= entry.record.authorizationExpiresAt) return { ok: false, reason: 'not_found' };

      entry.record.consumedAt = now;
      entry.record.retentionExpiresAt = now + LINK_COMPLETION_CONSUMED_RETENTION_MS;
      clearTimeout(entry.timer);
      entry.timer = armTimer(LINK_COMPLETION_CONSUMED_RETENTION_MS, () => records.delete(key));

      return { ok: true, record: entry.record };
    },
  };
}

export function createLinkCompletionStore(options: CreateLinkCompletionStoreOptions = {}): LinkCompletionStore {
  if (options.redisClient) {
    if (!options.keyspace) {
      throw new Error(
        'createLinkCompletionStore: `keyspace` is required whenever `redisClient` is supplied (feature-redis-key-prefix §1/§2) — ' +
          'resolve one via resolveRedisKeyspaceIfEnabled(crowi) before constructing the store.',
      );
    }
    return createRedisLinkCompletionStore(options.redisClient, options.keyspace);
  }
  if (options.requireRedis) {
    throw new Error(
      'createLinkCompletionStore: requireRedis is set but no redisClient was supplied — a declared multi-instance ' +
        'deployment must not silently fall back to a process-local store.',
    );
  }
  return createInMemoryLinkCompletionStore(options.now ?? Date.now);
}
