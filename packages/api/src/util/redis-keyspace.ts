import type Crowi from 'src/crowi';
import { redactUserinfo } from './redact-userinfo';

/**
 * Root segment every Crowi-owned Redis key/channel starts with, matching
 * the existing ACL convention (`apps/crowi-site/content/docs/en/operations/
 * redis.mdx`'s key/channel matrix is rooted at `crowi:`).
 */
const ROOT_SEGMENT = 'crowi';

/**
 * Same format the `REDIS_KEY_PREFIX` env var is validated against at boot
 * (`util/env-schema.ts`'s `validateRedisKeyPrefix` imports this exact
 * pattern rather than redeclaring an equivalent regex literal, so the two
 * checks can never drift apart) and the same format a `CLIENT_URL`-derived
 * hostname must also satisfy. Re-checked here as defense-in-depth: this
 * module's only two inputs are `crowi.getEnv()` and `crowi.getBaseUrl()`,
 * and a caller that builds a `Crowi`-shaped fixture bypassing
 * `validateEnv()` (tests, a future CLI entry point, ...) must still be
 * unable to produce a keyspace containing a stray `:` — that would silently
 * merge/split Redis keyspace segments, exactly the ambiguity this feature
 * exists to remove.
 */
export const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Reads only the two `Crowi` methods this module is allowed to use. The
 * spec (feature-redis-key-prefix §1) is explicit: no direct `process.env`
 * reads, and no `crowi:` literal rebuilt anywhere outside this file.
 */
type KeyspaceCrowi = Pick<Crowi, 'getBaseUrl' | 'getEnv'>;

/**
 * The single per-instance Redis keyspace namer. Every production Redis key
 * or pub/sub channel name Crowi owns is built through `key()` / `prefix()`
 * — never a hand-assembled `` `crowi:${something}` `` string — so instance
 * isolation is a structural invariant instead of something every call site
 * has to remember to apply.
 *
 * `key` and `prefix` are intentionally identical (both return
 * `crowi:<slug>:<suffix>`) — the two names exist so call sites read
 * naturally at their own use: `keyspace.key('presence', 'feed')` for a
 * literal Redis key/channel name, `keyspace.prefix('collab')` when handing
 * a prefix to something that appends its OWN sub-keys afterwards (e.g.
 * `@hocuspocus/extension-redis`'s `prefix` option).
 */
export interface RedisKeyspace {
  /** The resolved instance slug (the `<slug>` in `crowi:<slug>:<suffix>`), exposed for logging/debugging — never for reassembling a key by hand. */
  readonly slug: string;
  key(...segments: string[]): string;
  prefix(...segments: string[]): string;
}

/**
 * Memoizes {@link resolveRedisKeyspace}'s result per `Crowi`(-shaped)
 * instance, keyed by object identity. The acceptance criterion is "resolve
 * the instance slug once" — a real `Crowi` is a per-process singleton held
 * by every call site (`crowi.redis`, `crowi.model(...)`, ...), so keying a
 * `WeakMap` on that same reference means the slug is genuinely computed
 * exactly once for the lifetime of the process, no matter how many Redis
 * consumers call `resolveRedisKeyspace(crowi)` independently — while two
 * distinct `Crowi`-shaped fixtures (as unit tests build per-test) still
 * resolve independently, since they are different object references. A
 * `WeakMap` (rather than a module-level singleton) also means a test that
 * constructs a fresh fixture per `it()` never leaks a resolved slug into the
 * next test.
 */
const keyspaceCache = new WeakMap<KeyspaceCrowi, RedisKeyspace>();

/**
 * Resolves the Redis instance keyspace slug and returns the small
 * `key()`/`prefix()` API every Redis consumer builds its key/channel names
 * through (feature-redis-key-prefix §1). Every Redis-backed consumer
 * (presence / notifications / Hocuspocus extension / editor-cap /
 * rate-limit / Config sync / LRU) is wired onto this resolver; Phase 2's
 * remaining scope is the multi-process isolation/shared-namespace tests, not
 * further consumer wiring.
 *
 * Resolution order:
 *   1. `REDIS_KEY_PREFIX` (via `crowi.getEnv()`), when non-blank — an
 *      explicit operator override always wins.
 *   2. Otherwise the hostname of `crowi.getBaseUrl()` (i.e. `CLIENT_URL`) —
 *      replicas of the same public site share a `CLIENT_URL` and therefore
 *      automatically share a namespace (preserving intended cross-replica
 *      pub/sub), while distinct sites get distinct hostnames and therefore
 *      distinct namespaces with no extra configuration.
 *
 * Deliberately never falls back to the request `Host` / `X-Forwarded-Host`
 * header (see `hono/handlers/oauth.ts`'s `clientBaseUrl()` for the same
 * principle applied to OAuth) and never invents an ambiguous default like
 * `"default"` — an unresolvable slug throws, matching `env-schema.ts`'s
 * boot-time fail for "`REDIS_URL` set but neither `REDIS_KEY_PREFIX` nor a
 * valid `CLIENT_URL` is available". Reaching that throw in a fully-booted
 * process would mean env validation was bypassed (e.g. a test constructing
 * a `Crowi`-shaped fixture directly) or a future regression — silently
 * defaulting here would reintroduce exactly the cross-talk this feature
 * removes.
 *
 * Resolved (and cached — see {@link keyspaceCache}) once per `crowi`
 * instance: the first call for a given `crowi` does the env lookup + `URL`
 * parse and memoizes the result; every subsequent call with the SAME
 * `crowi` reference returns the cached {@link RedisKeyspace} without
 * re-reading `getEnv()`/`getBaseUrl()` — callers do not need to cache it
 * themselves.
 */
export function resolveRedisKeyspace(crowi: KeyspaceCrowi): RedisKeyspace {
  const cached = keyspaceCache.get(crowi);
  if (cached) return cached;

  const slug = resolveInstanceSlug(crowi);
  const build = (segments: readonly string[]): string => [ROOT_SEGMENT, slug, ...segments].join(':');
  const keyspace: RedisKeyspace = {
    slug,
    key: (...segments) => build(segments),
    prefix: (...segments) => build(segments),
  };
  keyspaceCache.set(crowi, keyspace);
  return keyspace;
}

/**
 * Attempts to derive a keyspace slug from a `CLIENT_URL` value: parses it as
 * an absolute URL and checks that its hostname also satisfies
 * {@link SLUG_PATTERN}. Shared by {@link resolveInstanceSlug} (the runtime
 * resolution path below) AND `util/env-schema.ts`'s boot-time cross-field
 * check, so the two can never diverge on which `CLIENT_URL` values can
 * actually back a Redis keyspace — see that module's
 * `detectUnresolvableRedisKeyspace()` doc comment for why a `CLIENT_URL` that
 * is merely "absolute" (passes `validateAbsoluteUrl()`) is not sufficient: an
 * IPv6-literal host (e.g. `[::1]`) is a valid absolute URL but does not fit
 * the slug format, and boot validation must reject that case with the exact
 * same rule this function's runtime caller enforces.
 *
 * Exported (rather than kept module-private) specifically for that
 * cross-module reuse — not intended as a general-purpose URL helper.
 */
export function resolveClientUrlSlug(baseUrl: string): { readonly slug: string } | { readonly error: string } {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    return { error: `CLIENT_URL ${JSON.stringify(redactUserinfo(baseUrl))} is not a valid absolute URL` };
  }

  // Deliberately no allowance for hostnames that don't fit the slug format
  // (IPv6 literals like `[::1]`, which contain `[`/`]`/`:`) — the spec leaves
  // this case open ("未確定事項"), and failing loudly with an explicit-override
  // instruction is the choice consistent with never inventing an ambiguous
  // fallback elsewhere in this module. Note that a punycode-encoded
  // internationalized hostname (e.g. `xn--...`) is plain ASCII alphanumerics
  // and hyphens, so it DOES satisfy `SLUG_PATTERN` and is not an example of a
  // rejected hostname — the WHATWG `URL` parser always normalizes an IDN
  // hostname to its punycode form before `hostname` is read here. `hostname`
  // itself never carries credentials (the WHATWG `URL` parser splits userinfo
  // out separately), so it is safe to echo verbatim — only the raw `baseUrl`
  // above needs redaction.
  if (!hostname || !SLUG_PATTERN.test(hostname)) {
    return { error: `CLIENT_URL's hostname ${JSON.stringify(hostname)} does not match ${SLUG_PATTERN} (e.g. an IPv6 literal)` };
  }

  return { slug: hostname };
}

/**
 * `resolveRedisKeyspace`, but only when Redis is actually in play —
 * `crowi.redis` is `null` in single-instance dev (`REDIS_URL` unset), and
 * resolving a keyspace requires a resolvable instance slug (§1) dev never
 * needs. Every Redis-touching consumer (presence / notifications /
 * editor-cap / rate-limit / MCP / attachment / autocomplete / page-preview /
 * page routes) repeats this same "only resolve when redis is non-null"
 * guard, so it lives here once instead of as a `crowi.redis ? ... :
 * undefined` ternary at each call site.
 */
export function resolveRedisKeyspaceIfEnabled(crowi: Pick<Crowi, 'getBaseUrl' | 'getEnv' | 'redis'>): RedisKeyspace | undefined {
  return crowi.redis ? resolveRedisKeyspace(crowi) : undefined;
}

function resolveInstanceSlug(crowi: KeyspaceCrowi): string {
  const override = crowi.getEnv().REDIS_KEY_PREFIX?.trim();
  if (override) {
    if (!SLUG_PATTERN.test(override)) {
      throw new Error(
        `cannot resolve a Redis instance keyspace: REDIS_KEY_PREFIX ${JSON.stringify(override)} does not match ${SLUG_PATTERN} — ` +
          "this should already have been rejected at boot by env-schema.ts's validateEnv().",
      );
    }
    return override;
  }

  const baseUrl = crowi.getBaseUrl();
  if (!baseUrl) {
    throw new Error(
      'cannot resolve a Redis instance keyspace: REDIS_KEY_PREFIX is unset and CLIENT_URL is unset. Set REDIS_KEY_PREFIX ' +
        "explicitly — this should already have been rejected at boot by env-schema.ts's validateEnv() whenever REDIS_URL is set.",
    );
  }

  const resolved = resolveClientUrlSlug(baseUrl);
  if ('error' in resolved) {
    throw new Error(`cannot resolve a Redis instance keyspace: ${resolved.error}. Set REDIS_KEY_PREFIX explicitly.`);
  }
  return resolved.slug;
}
