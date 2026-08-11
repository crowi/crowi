/**
 * Central `process.env` validation (item #25 / ops-no-central-env-validation).
 *
 * Before this module, ~15 places under `packages/api/src` read `process.env.X`
 * / `this.env.X` directly, each picking its own failure mode (throw / warn /
 * silent-fallback-to-default). A typo in an env var name would, depending on
 * which one you typo'd, either abort boot, log a warning, or silently do
 * nothing at all.
 *
 * `validateEnv()` is called exactly once, from the `Crowi` constructor
 * (`crowi/index.ts`), and:
 *
 *   - Walks the {@link ENV_VAR_DESCRIPTORS} classification table. Each descriptor
 *     optionally carries a `check` (a `validate` function + `fail`/`warn`
 *     severity) that only runs when the variable (or one of its aliases) is
 *     actually set.
 *   - Runs a typo-detection heuristic (Levenshtein distance) over env keys
 *     that look like Crowi variables but match no known name.
 *   - If ANY `fail`-severity variable is invalid, throws a single `Error`
 *     that lists every failing variable (not just the first one).
 *   - Otherwise returns `{ values, warnings }`: `values` are the handful of
 *     derived fields the constructor needs (`baseUrl` / `nodeEnv` / `port` /
 *     `redisUrl` / `mongoUri` / `encryptionKey`), `warnings` are
 *     human-readable strings the constructor stashes for a consolidated
 *     boot-time report.
 *
 * Deliberately NOT covered here (see the spec's "未確定事項" / out-of-scope
 * list): `WS_TOKEN_SECRET`'s placeholder-rejection logic (still owned by
 * `util/signed-token-factory.ts` — this module only adds a minimum-length
 * check on top, see {@link WS_TOKEN_SECRET_DESCRIPTOR}), `REDIS_URL`
 * connection-time failures (vs. format), `CROWI_ENCRYPTION_KEY`'s runtime
 * re-read in `util/crypto.ts` (`EnvKeyProvider.getKey()`), and module-level
 * constants that are evaluated at `import` time (`util/jwt.ts`,
 * `util/collab-cap.ts`, `hono/handlers/oauth.ts`) — those are registered here
 * as taxonomy (so a typo is at least visible as a warning) but their actual
 * parsing stays where it is.
 */

import { redactUserinfo } from './redact-userinfo';
import { parseRedisDatabase } from './redis-database';
import { SLUG_PATTERN as REDIS_KEY_PREFIX_PATTERN, resolveClientUrlSlug } from './redis-keyspace';
import { isKnownSignedTokenSecretPlaceholder } from './signed-token-factory';

/** A single env var's shape: canonical name, legacy aliases, and an optional content check. */
export interface EnvVarDescriptor {
  /** Canonical variable name. */
  readonly name: string;
  /**
   * Legacy/alternate names checked BEFORE `name` (matches the precedence the
   * pre-existing inline `||` chains used, e.g. `MONGOLAB_URI` before
   * `MONGO_URI`). Absent for variables with no alias.
   */
  readonly aliases?: readonly string[];
  /**
   * Present for variables whose VALUE is checked. Absent for
   * taxonomy-only variables — those are still registered (so typo-detection
   * recognises the name and existing consumers keep resolving them
   * themselves), just not content-validated here.
   */
  readonly check?: {
    /**
     * Fixed for almost every descriptor. `WS_TOKEN_SECRET` is the one
     * exception (its minimum-length check must fail boot in production but
     * only warn elsewhere — see the feature-signed-token-secret-strength
     * spec's "未確定事項"), so a descriptor may instead supply a function of
     * the validated `env` that resolves to `'fail'` or `'warn'` at check
     * time, read from the SAME `env` argument `validateEnv()` received (not
     * ambient `process.env` — see `WS_TOKEN_SECRET_DESCRIPTOR`'s doc comment).
     */
    readonly severity: 'fail' | 'warn' | ((env: NodeJS.ProcessEnv) => 'fail' | 'warn');
    /** Returns a human-readable reason when `raw` is invalid, or `null` when valid. */
    readonly validate: (raw: string) => string | null;
  };
  /**
   * A warning to surface when the variable is entirely unset — distinct from
   * `check`, which only ever runs once a value IS present. Currently only
   * `CLIENT_URL` uses this (moved here from a separate `console.warn` inside
   * `setupMailer()` so every env-derived boot warning, "missing" or
   * "malformed", comes out of the one consolidated report — AC-12).
   */
  readonly warnWhenUnset?: string;
}

function validatePort(raw: string): string | null {
  const trimmed = raw.trim();
  const parsed = Number.parseInt(trimmed, 10);
  if (!/^\d+$/.test(trimmed) || parsed < 1 || parsed > 65535) {
    return `must be an integer between 1 and 65535 (got ${JSON.stringify(raw)})`;
  }
  return null;
}

function validateMongoUri(raw: string): string | null {
  if (!/^mongodb(\+srv)?:\/\//.test(raw.trim())) {
    return `must start with "mongodb://" or "mongodb+srv://" (got ${JSON.stringify(redactUserinfo(raw))})`;
  }
  return null;
}

/**
 * Also validates the pathname (feature-redis-key-prefix §3) via the shared
 * `parseRedisDatabase()` — the SAME parser `util/redis-opts.ts` and
 * `collab/extension-redis.ts` use to pick the node-redis `database` /
 * ioredis `db` option, so a malformed pathname (`/foo`, `/-1`, `/1/extra`,
 * ...) boot-aborts here instead of each client silently picking its own
 * fallback (which historically was "ignore the pathname entirely and
 * connect to DB 0").
 */
function validateRedisUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^rediss?:\/\//.test(trimmed)) {
    return `must start with "redis://" or "rediss://" (got ${JSON.stringify(redactUserinfo(raw))})`;
  }
  const parsedDb = parseRedisDatabase(trimmed);
  if ('error' in parsedDb) {
    return parsedDb.error;
  }
  return null;
}

/**
 * `REDIS_KEY_PREFIX` becomes the instance slug `util/redis-keyspace.ts`
 * builds every Redis key/channel from (`crowi:<slug>:<suffix>`) — see that
 * module's doc comment. Reuses that module's own `SLUG_PATTERN` (imported
 * above as `REDIS_KEY_PREFIX_PATTERN`) rather than redeclaring an equivalent
 * regex literal, so the boot-time check here and the runtime check in
 * `resolveRedisKeyspace()` can never drift apart. A colon would silently
 * merge/split keyspace segments, and anything outside `[A-Za-z0-9._-]` risks
 * characters Redis ACL glob patterns (`~crowi:<slug>:*`) don't handle
 * predictably, so both are rejected outright rather than sanitised.
 */
function validateRedisKeyPrefix(raw: string): string | null {
  if (raw === '') {
    return 'must not be blank/whitespace-only — it becomes the Redis instance keyspace slug (e.g. "crowi:<value>:...")';
  }
  if (raw.includes(':')) {
    return `must not contain ":" (got ${JSON.stringify(raw)}) — colons separate Redis keyspace segments`;
  }
  if (!REDIS_KEY_PREFIX_PATTERN.test(raw)) {
    return `must match ${REDIS_KEY_PREFIX_PATTERN} (got ${JSON.stringify(raw)})`;
  }
  return null;
}

function validateEncryptionKey(raw: string): string | null {
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    return `must decode to exactly 32 bytes after base64 decoding (got ${buf.length}). Generate one with \`openssl rand -base64 32\`.`;
  }
  return null;
}

/**
 * Minimum length, in characters (not decoded bytes — the spec's open
 * question resolves this as a plain character count so a strong-but-not-
 * base64 secret is never incorrectly rejected), for `WS_TOKEN_SECRET`: the
 * shared secret `createSignedTokenUtil`'s `DEFAULT_SECRET_ENV_VAR` falls
 * back to (`util/signed-token-factory.ts`), and the only env var any of its
 * four current call sites (ws / presence / notifications / mail token) pass
 * to `secretEnvVar` — all four omit the option, so `WS_TOKEN_SECRET` is the
 * complete set. A value this short is trivially guessable as an HMAC-SHA256
 * signing key; `openssl rand -base64 32` (44 base64 characters) comfortably
 * clears this bar.
 */
const MIN_SIGNED_TOKEN_SECRET_LENGTH = 32;

/**
 * A known placeholder (`changeme` etc.) is exempt — `signed-token-factory.ts`
 * already treats it as "not configured" (random in-memory fallback + its own
 * warning), and this check must not change that classification, only tighten
 * what counts as a genuinely *configured* secret.
 */
function validateSignedTokenSecretLength(raw: string): string | null {
  if (isKnownSignedTokenSecretPlaceholder(raw)) return null;
  if (raw.length >= MIN_SIGNED_TOKEN_SECRET_LENGTH) return null;
  return (
    `must be at least ${MIN_SIGNED_TOKEN_SECRET_LENGTH} characters (got ${raw.length}) — it signs realtime ` +
    'collab / presence / notifications / mail tokens as an HMAC-SHA256 key, and a value this short is easily ' +
    'guessable. Generate a strong one with `openssl rand -base64 32`.'
  );
}

/** `NODE_ENV`'s fallback when unset — shared by {@link isProductionEnv} and `EnvValidationResult.values.nodeEnv` so the two can't drift apart. */
const DEFAULT_NODE_ENV = 'production';

/** The effective NODE_ENV boot decisions use (mirrors `EnvValidationResult.values.nodeEnv`'s own fallback), not merely whatever happens to be set. */
function isProductionEnv(env: NodeJS.ProcessEnv): boolean {
  return (env.NODE_ENV || DEFAULT_NODE_ENV) === DEFAULT_NODE_ENV;
}

function validateAbsoluteUrl(raw: string): string | null {
  const invalidMessage = `must be an absolute URL starting with "http://" or "https://" (got ${JSON.stringify(redactUserinfo(raw))})`;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return invalidMessage;
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.host === '') {
    return invalidMessage;
  }
  return null;
}

/**
 * RFC-0014 phase 1 §5 — origin-only variant of {@link validateAbsoluteUrl}
 * for `AUTH_PUBLIC_API_URL` / `AUTH_PUBLIC_WEB_URL`: every federated-auth
 * redirect URI / handoff audience is built by string concatenation onto
 * one of these two trusted values, so a stray path/userinfo/query/fragment
 * here would silently corrupt every URL built from it. Reuses
 * `validateAbsoluteUrl`'s own check first (same base "is this even an
 * absolute http(s) URL" rule), then rejects anything beyond a bare origin.
 * A trailing slash (`pathname === '/'`) is accepted here and normalized
 * away by {@link normalizeOriginOnlyUrl} — `new URL(...)` always reports a
 * bare origin's pathname as `'/'`, so rejecting it would reject the most
 * common way to type an origin.
 */
function validateOriginOnlyUrl(raw: string): string | null {
  const base = validateAbsoluteUrl(raw);
  if (base) return base;
  const redacted = JSON.stringify(redactUserinfo(raw));
  const parsed = new URL(raw); // already proven parseable by validateAbsoluteUrl above
  if (parsed.username !== '' || parsed.password !== '') {
    return `must be an origin only, with no userinfo (got ${redacted})`;
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    return `must be an origin only, with no path (got ${redacted})`;
  }
  if (parsed.search !== '') {
    return `must be an origin only, with no query string (got ${redacted})`;
  }
  if (parsed.hash !== '') {
    return `must be an origin only, with no fragment (got ${redacted})`;
  }
  return null;
}

/**
 * `new URL(raw).origin` — normalizes away a trailing slash / bare `/`
 * pathname. Callers MUST have already passed `raw` through
 * {@link validateOriginOnlyUrl} (returned `null`) — this function does not
 * re-validate.
 */
function normalizeOriginOnlyUrl(raw: string): string {
  return new URL(raw).origin;
}

/**
 * `isMultiInstanceDeclared()` (`src/collab/attach.ts`) itself treats any
 * other non-empty string as truthy — that behaviour is unchanged. This only
 * flags the values it treats as "probably a typo" so an operator sees it.
 */
function validateMultiInstance(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'true' || trimmed === 'false') return null;
  const asNumber = Number(trimmed);
  if (Number.isInteger(asNumber) && asNumber >= 0) return null;
  return (
    `should be "1", "0", "true", "false", or a non-negative integer (got ${JSON.stringify(raw)}) — ` +
    'any other value is currently treated as an enabled multi-instance declaration.'
  );
}

const VALID_NODE_ENVS = ['development', 'production', 'test'];

function validateNodeEnv(raw: string): string | null {
  if (VALID_NODE_ENVS.includes(raw.trim())) return null;
  return `should be one of ${VALID_NODE_ENVS.join(', ')} (got ${JSON.stringify(raw)})`;
}

function validatePositiveInt(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) || Number.parseInt(trimmed, 10) <= 0) {
    return `must be a positive integer (got ${JSON.stringify(raw)})`;
  }
  return null;
}

function validateMigrationPolicy(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === 'warn' || trimmed === 'block') return null;
  return `must be "warn" or "block" (got ${JSON.stringify(raw)})`;
}

const PORT_DESCRIPTOR: EnvVarDescriptor = {
  name: 'PORT',
  check: { severity: 'fail', validate: validatePort },
};

const MONGO_URI_DESCRIPTOR: EnvVarDescriptor = {
  name: 'MONGO_URI',
  aliases: ['MONGOLAB_URI', 'MONGODB_URI', 'MONGOHQ_URL'],
  check: { severity: 'fail', validate: validateMongoUri },
};

const REDIS_URL_DESCRIPTOR: EnvVarDescriptor = {
  name: 'REDIS_URL',
  aliases: ['REDISTOGO_URL', 'REDIS_TLS_URL'],
  check: { severity: 'fail', validate: validateRedisUrl },
};

/**
 * feature-redis-key-prefix §1 — explicit override for the Redis instance
 * keyspace slug `util/redis-keyspace.ts` resolves (else derived from
 * `CLIENT_URL`'s hostname — see {@link detectUnresolvableRedisKeyspace}).
 * Independent of whether `REDIS_URL` is set at all: like every other
 * descriptor here, a malformed value fails regardless of whether the
 * variable is actually load-bearing yet.
 */
const REDIS_KEY_PREFIX_DESCRIPTOR: EnvVarDescriptor = {
  name: 'REDIS_KEY_PREFIX',
  check: { severity: 'fail', validate: validateRedisKeyPrefix },
};

const CROWI_ENCRYPTION_KEY_DESCRIPTOR: EnvVarDescriptor = {
  name: 'CROWI_ENCRYPTION_KEY',
  check: { severity: 'fail', validate: validateEncryptionKey },
};

const CLIENT_URL_DESCRIPTOR: EnvVarDescriptor = {
  name: 'CLIENT_URL',
  check: { severity: 'warn', validate: validateAbsoluteUrl },
  // Pre-existing behaviour (previously a standalone `console.warn` inside
  // `setupMailer()`, fired mid-boot instead of as part of the consolidated
  // report): without a public origin, links in outgoing mail fall back to
  // relative paths and don't work. Folded in here so it shows up in the
  // same one-report-at-boot-top output as every other env warning (AC-12).
  warnWhenUnset:
    'is not set — links in outgoing emails (invite / activation / password reset / email change) will be ' +
    'relative and will not work. Set CLIENT_URL to the web app origin (e.g. https://wiki.example.com).',
};

/**
 * RFC-0014 phase 1 §5 — trusted origin every callback redirect URI is built
 * from. Only checked when SET (same convention as every other descriptor
 * here): a value present but malformed boot-fails, matching e.g.
 * `MONGO_URI`. When entirely unset, `AUTH_PUBLIC_API_URL` falls back to the
 * resolved `AUTH_PUBLIC_WEB_URL` (same-origin deployment) — see
 * {@link resolveFederatedAuthPublicUrls} — which is NOT a boot failure:
 * federated auth simply stays disabled (provider list empty, `/start`
 * 404s) until an operator configures a federated-auth plugin's trusted
 * origins.
 */
const AUTH_PUBLIC_API_URL_DESCRIPTOR: EnvVarDescriptor = {
  name: 'AUTH_PUBLIC_API_URL',
  check: { severity: 'fail', validate: validateOriginOnlyUrl },
};

/**
 * RFC-0014 phase 1 §5 — trusted web origin `/login/complete` redirects
 * target. Falls back to `CLIENT_URL` (re-validated as origin-only — a
 * `CLIENT_URL` with a path cannot back this) when unset; see
 * {@link resolveFederatedAuthPublicUrls}.
 */
const AUTH_PUBLIC_WEB_URL_DESCRIPTOR: EnvVarDescriptor = {
  name: 'AUTH_PUBLIC_WEB_URL',
  check: { severity: 'fail', validate: validateOriginOnlyUrl },
};

const CROWI_MULTI_INSTANCE_DESCRIPTOR: EnvVarDescriptor = {
  name: 'CROWI_MULTI_INSTANCE',
  check: { severity: 'warn', validate: validateMultiInstance },
};

const NODE_ENV_DESCRIPTOR: EnvVarDescriptor = {
  name: 'NODE_ENV',
  check: { severity: 'warn', validate: validateNodeEnv },
};

const JWT_ACCESS_TTL_DESCRIPTOR: EnvVarDescriptor = {
  name: 'JWT_ACCESS_TOKEN_TTL_SECONDS',
  check: { severity: 'warn', validate: validatePositiveInt },
};

const JWT_REFRESH_TTL_DESCRIPTOR: EnvVarDescriptor = {
  name: 'JWT_REFRESH_TOKEN_TTL_SECONDS',
  check: { severity: 'warn', validate: validatePositiveInt },
};

const COLLAB_MAX_EDITORS_DESCRIPTOR: EnvVarDescriptor = {
  name: 'COLLAB_MAX_EDITORS_PER_PAGE',
  check: { severity: 'warn', validate: validatePositiveInt },
};

const MIGRATION_POLICY_DESCRIPTOR: EnvVarDescriptor = {
  name: 'MIGRATION_PREFLIGHT_UNAPPLIED_POLICY',
  check: { severity: 'warn', validate: validateMigrationPolicy },
};

/**
 * feature-image-derivative-optimization §8 — decode-time pixel ceiling
 * (`sharp`'s `limitInputPixels`) for the display-derivative generator.
 * Resource-safety floor, not a cosmetic tuning knob, but still only
 * `warn`-severity here: an invalid value falls back to the spec-fixed
 * default (50,000,000) at the point of use
 * (`util/image-display-derivative.ts`'s own `resolvePositiveIntEnv`),
 * exactly like `COLLAB_MAX_EDITORS_PER_PAGE` — this descriptor only makes
 * a malformed value visible in the consolidated boot report.
 */
const IMAGE_DERIVATIVE_MAX_PIXELS_DESCRIPTOR: EnvVarDescriptor = {
  name: 'IMAGE_DERIVATIVE_MAX_PIXELS',
  check: { severity: 'warn', validate: validatePositiveInt },
};

/**
 * The attachment upload size limit. Same posture as
 * `IMAGE_DERIVATIVE_MAX_PIXELS` above: `warn`-severity
 * format check only (a malformed value is made visible in the
 * consolidated boot report), while the actual default/ceiling/clamping
 * logic is owned by `util/upload-limit.ts`'s `resolveUploadMaxBytes` at
 * the point of use — this descriptor exists so the typo-detection
 * heuristic recognises the documented name instead of flagging a
 * correctly-set `CROWI_UPLOAD_MAX_BYTES` as an unknown `CROWI_*` variable.
 */
const CROWI_UPLOAD_MAX_BYTES_DESCRIPTOR: EnvVarDescriptor = {
  name: 'CROWI_UPLOAD_MAX_BYTES',
  check: { severity: 'warn', validate: validatePositiveInt },
};

/** feature-image-derivative-optimization §8 — upload-path admission semaphore capacity (default 2). */
const IMAGE_DERIVATIVE_ADMISSION_CONCURRENCY_DESCRIPTOR: EnvVarDescriptor = {
  name: 'IMAGE_DERIVATIVE_ADMISSION_CONCURRENCY',
  check: { severity: 'warn', validate: validatePositiveInt },
};

/** feature-image-derivative-optimization §8 — upload-path admission semaphore acquire timeout in ms (default 5000). */
const IMAGE_DERIVATIVE_ADMISSION_TIMEOUT_MS_DESCRIPTOR: EnvVarDescriptor = {
  name: 'IMAGE_DERIVATIVE_ADMISSION_TIMEOUT_MS',
  check: { severity: 'warn', validate: validatePositiveInt },
};

/**
 * Feature-signed-token-secret-strength: promoted out of
 * {@link TAXONOMY_ONLY_NAMES} to its own descriptor with a content check.
 * Severity is NOT a fixed `'fail'`/`'warn'` like every other descriptor —
 * `NODE_ENV=production` (including unset, which defaults to `'production'`,
 * matching `values.nodeEnv`'s own fallback) must boot-fail on a
 * short-but-set value, while every other `NODE_ENV` (dev / test / anything
 * else explicitly set) only warns. This reads `NODE_ENV` from the `env`
 * argument `validateEnv()` was called with, never ambient `process.env` —
 * the existing test suite (`env-schema.test.ts`) exercises `NODE_ENV`
 * entirely through synthetic `makeEnv()` objects that never touch the real
 * process env, and jest runs with the real `process.env.NODE_ENV` pinned to
 * `'test'` regardless of what a given test's synthetic env claims.
 */
const WS_TOKEN_SECRET_DESCRIPTOR: EnvVarDescriptor = {
  name: 'WS_TOKEN_SECRET',
  check: {
    severity: (env) => (isProductionEnv(env) ? 'fail' : 'warn'),
    validate: validateSignedTokenSecretLength,
  },
};

/**
 * Taxonomy-only variables: registered so typo-detection recognises them (and
 * so a real consumer's own resolution logic isn't duplicated here), but their
 * content is not checked.
 */
const TAXONOMY_ONLY_NAMES = [
  'REDIS_REJECT_UNAUTHORIZED',
  'BASE_URL',
  'PASSWORD_SEED',
  'SECRET_TOKEN',
  'ENABLE_DNSCACHE',
  'DEBUG',
  // `migration/helpers.ts:resolveActingUserId()` — the email of the user to
  // credit preflight migration body rewrites to. No format check here: it's
  // a free-form email, and an unresolvable value already throws its own
  // specific error at the point of use.
  'CROWI_MIGRATE_USER',
] as const;

const TAXONOMY_ONLY_DESCRIPTORS: EnvVarDescriptor[] = TAXONOMY_ONLY_NAMES.map((name) => ({ name }));

/**
 * The full descriptor taxonomy (AC-1): every Crowi-owned env var
 * `@crowi/api` reads, exported so it can be inspected/asserted on directly
 * (e.g. "is this var registered at all") instead of only indirectly through
 * {@link validateEnv}'s behaviour.
 */
export const ENV_VAR_DESCRIPTORS: readonly EnvVarDescriptor[] = [
  PORT_DESCRIPTOR,
  MONGO_URI_DESCRIPTOR,
  REDIS_URL_DESCRIPTOR,
  REDIS_KEY_PREFIX_DESCRIPTOR,
  CROWI_ENCRYPTION_KEY_DESCRIPTOR,
  CLIENT_URL_DESCRIPTOR,
  AUTH_PUBLIC_API_URL_DESCRIPTOR,
  AUTH_PUBLIC_WEB_URL_DESCRIPTOR,
  CROWI_MULTI_INSTANCE_DESCRIPTOR,
  NODE_ENV_DESCRIPTOR,
  JWT_ACCESS_TTL_DESCRIPTOR,
  JWT_REFRESH_TTL_DESCRIPTOR,
  COLLAB_MAX_EDITORS_DESCRIPTOR,
  MIGRATION_POLICY_DESCRIPTOR,
  WS_TOKEN_SECRET_DESCRIPTOR,
  IMAGE_DERIVATIVE_MAX_PIXELS_DESCRIPTOR,
  IMAGE_DERIVATIVE_ADMISSION_CONCURRENCY_DESCRIPTOR,
  IMAGE_DERIVATIVE_ADMISSION_TIMEOUT_MS_DESCRIPTOR,
  CROWI_UPLOAD_MAX_BYTES_DESCRIPTOR,
  ...TAXONOMY_ONLY_DESCRIPTORS,
];

/**
 * Known-but-not-consumed-by-`@crowi/api` names. These exist in
 * `.env.example` (read by `@crowi/web` or a plugin, e.g. the browser or the
 * Next.js server), so they must NOT be flagged as typos here even though
 * `@crowi/api` never reads them itself.
 */
const EXTRA_KNOWN_NAMES = ['NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_COLLAB_URL', 'CROWI_API_URL', 'SLACK_MANIFEST_REQUEST_URL'] as const;

const KNOWN_ENV_NAMES: ReadonlySet<string> = new Set([...ENV_VAR_DESCRIPTORS.flatMap((d) => [d.name, ...(d.aliases ?? [])]), ...EXTRA_KNOWN_NAMES]);

/** Prefixes a Crowi-owned env var is expected to carry. Anything else (`PATH`, `CI`, `GITHUB_*`, `npm_*`, ...) is out of scope for typo-detection. */
const TYPO_PREFIXES = ['CROWI_', 'WS_TOKEN_', 'JWT_', 'COLLAB_', 'REDIS', 'MONGO', 'MIGRATION_', 'IMAGE_DERIVATIVE_'] as const;

/** Edit-distance threshold for the typo heuristic (implementer's discretion per the spec, "目安 ≤2"). */
const TYPO_DISTANCE_THRESHOLD = 2;

/** Known names shorter than this are excluded as comparison targets — a short name (e.g. a 3-letter one) makes almost any nearby key a "typo" false positive. */
const TYPO_CANDIDATE_MIN_LENGTH = 4;

/** Classic Wagner–Fischer DP edit distance. No new dependency — this is the only place it's needed. */
function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, (_, i) => {
    const row = new Array<number>(cols).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j < cols; j += 1) dp[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[rows - 1][cols - 1];
}

/**
 * Heuristic typo detection (AC-11): any env key that looks Crowi-owned
 * (matches a {@link TYPO_PREFIXES} prefix) but isn't a known name, and whose
 * closest known name is within {@link TYPO_DISTANCE_THRESHOLD} edits, gets a
 * warning. False positives are accepted by design — this only ever warns,
 * never fails boot.
 */
function detectTypoWarnings(env: NodeJS.ProcessEnv): string[] {
  const candidates = [...KNOWN_ENV_NAMES].filter((name) => name.length >= TYPO_CANDIDATE_MIN_LENGTH);
  const warnings: string[] = [];

  for (const key of Object.keys(env)) {
    if (KNOWN_ENV_NAMES.has(key)) continue;
    if (!TYPO_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;

    let closest: string | null = null;
    let minDistance = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const distance = levenshteinDistance(key, candidate);
      if (distance < minDistance) {
        minDistance = distance;
        closest = candidate;
      }
    }

    if (closest != null && minDistance <= TYPO_DISTANCE_THRESHOLD) {
      warnings.push(`${key}: does not match any known Crowi environment variable — did you mean "${closest}"? (edit distance ${minDistance})`);
    }
  }

  return warnings;
}

/**
 * Cross-field invariant (feature-redis-key-prefix §1): whenever `REDIS_URL`
 * is set, `util/redis-keyspace.ts` MUST be able to resolve an instance
 * keyspace slug at runtime — either an explicit `REDIS_KEY_PREFIX` override
 * (format-validated independently above, whenever it's set at all) or a
 * valid absolute `CLIENT_URL` whose HOSTNAME also satisfies the same slug
 * format `util/redis-keyspace.ts` requires, to derive one from. Neither
 * present is a boot-abort, not a silent `crowi:default` fallback — that
 * fallback is exactly the silent cross-talk this feature exists to prevent.
 *
 * This spans THREE independently-resolved descriptors (`REDIS_URL`,
 * `REDIS_KEY_PREFIX`, `CLIENT_URL`), so it can't be expressed as a single
 * descriptor's `check.validate(raw)` — structurally the same kind of
 * post-loop, multi-value pass {@link detectTypoWarnings} already does,
 * except this one can push into `failMessages` instead of only ever
 * warning.
 *
 * When `REDIS_KEY_PREFIX` IS set but fails its own format check, that
 * failure is already reported by {@link REDIS_KEY_PREFIX_DESCRIPTOR}'s
 * `check` in the main loop — this function only re-raises when the
 * variable is unresolved, never re-flags an already-invalid override.
 *
 * Uses the SAME `resolveClientUrlSlug()` `util/redis-keyspace.ts` itself
 * calls at runtime (not a re-implemented `validateAbsoluteUrl()`-only check)
 * — a `CLIENT_URL` that is absolute per {@link validateAbsoluteUrl} but whose
 * hostname doesn't fit the slug pattern (an IPv6 literal like `https://[::1]`)
 * must fail HERE at boot, otherwise `validateEnv()`
 * would pass while `resolveRedisKeyspace()` throws the very first time a
 * fully-booted process tries to build a Redis key — the exact boot-time /
 * runtime divergence this cross-field check exists to rule out.
 *
 * When `CLIENT_URL` IS absolute but its hostname specifically fails the slug
 * check, the failure message includes `resolveClientUrlSlug()`'s own
 * `.error` (e.g. naming the offending hostname) instead of only the generic
 * "neither ... is available" wording — an operator staring at an IPv6-literal
 * `CLIENT_URL` needs to see THAT it's the hostname shape at fault, not just
 * be told to set `REDIS_KEY_PREFIX` with no further explanation.
 */
function detectUnresolvableRedisKeyspace(resolvedByDescriptor: ReadonlyMap<EnvVarDescriptor, ReturnType<typeof resolveRaw>>): string | null {
  if (!resolvedByDescriptor.get(REDIS_URL_DESCRIPTOR)) return null; // Redis unused — no keyspace to resolve.
  if (resolvedByDescriptor.get(REDIS_KEY_PREFIX_DESCRIPTOR)) return null; // Explicit override present.

  const REDIS_KEY_PREFIX_INSTRUCTION =
    'set REDIS_KEY_PREFIX explicitly (e.g. REDIS_KEY_PREFIX=my-instance) so multiple Crowi instances sharing this ' +
    'Redis do not cross-talk on the same keys/channels.';

  const clientUrl = resolvedByDescriptor.get(CLIENT_URL_DESCRIPTOR);
  if (clientUrl && validateAbsoluteUrl(clientUrl.raw) == null) {
    const slugResult = resolveClientUrlSlug(clientUrl.raw);
    if (!('error' in slugResult)) return null; // CLIENT_URL derives a slug.
    return `REDIS_URL is set, REDIS_KEY_PREFIX is unset, and ${slugResult.error} — ${REDIS_KEY_PREFIX_INSTRUCTION}`;
  }

  return `REDIS_URL is set but neither REDIS_KEY_PREFIX nor a valid CLIENT_URL is available to derive a Redis instance keyspace slug from — ${REDIS_KEY_PREFIX_INSTRUCTION}`;
}

/**
 * RFC-0014 phase 1 §5 — resolve the federated-auth trusted origin fallback
 * chain: `AUTH_PUBLIC_WEB_URL` defaults to `CLIENT_URL` RE-VALIDATED as
 * origin-only (a `CLIENT_URL` carrying a path/query/userinfo cannot back
 * this — see {@link validateOriginOnlyUrl}); `AUTH_PUBLIC_API_URL` defaults
 * to the resolved web URL (same-origin deployment). Both explicit values
 * are already boot-fail-validated by their own descriptors above whenever
 * set, so this function only re-validates `CLIENT_URL` (which has its own,
 * more permissive, `validateAbsoluteUrl` check).
 *
 * Unlike {@link detectUnresolvableRedisKeyspace}, an unresolvable result
 * here is NEVER a boot failure — every existing deployment that has not
 * configured a federated-auth plugin has none of these three variables
 * set. `Crowi.getFederatedAuthPublicUrls()` returns this value (`null` when
 * unresolvable) and the federated-auth routes disable themselves (empty
 * provider list, `/start` 404s) rather than aborting boot.
 */
function resolveFederatedAuthPublicUrls(
  resolvedByDescriptor: ReadonlyMap<EnvVarDescriptor, ReturnType<typeof resolveRaw>>,
): { apiUrl: string; webUrl: string } | null {
  const explicitWeb = resolvedByDescriptor.get(AUTH_PUBLIC_WEB_URL_DESCRIPTOR);
  let webUrl: string | null = explicitWeb ? normalizeOriginOnlyUrl(explicitWeb.raw) : null;
  if (!webUrl) {
    const clientUrl = resolvedByDescriptor.get(CLIENT_URL_DESCRIPTOR);
    if (clientUrl && validateOriginOnlyUrl(clientUrl.raw) == null) {
      webUrl = normalizeOriginOnlyUrl(clientUrl.raw);
    }
  }
  if (!webUrl) return null;

  const explicitApi = resolvedByDescriptor.get(AUTH_PUBLIC_API_URL_DESCRIPTOR);
  const apiUrl = explicitApi ? normalizeOriginOnlyUrl(explicitApi.raw) : webUrl;
  return { apiUrl, webUrl };
}

/**
 * First truthy value among `descriptor`'s aliases (checked first, matching
 * the pre-existing precedence) then `descriptor.name`. `null` when none are
 * set.
 *
 * "Set" is decided on the RAW string, before trimming — matching every
 * pre-existing `this.env.X || default` / `this.env.X ?  : default` /
 * `if (!raw)` check this module replaces, which all treat only the empty
 * string `""` as absent. A whitespace-only value (`"   "`) was truthy under
 * every one of those checks, so it counts as "set" here too: a value of
 * `PORT="   "` (or `MONGO_URI`/`CROWI_ENCRYPTION_KEY`/...) must flow into
 * `check.validate()` and fail/warn like any other malformed value, not
 * silently fall back to the default as if the variable were never set (that
 * would defeat the fail-fast/warn-visibility this module exists to add — see
 * AC-3/4/5/6 — and for `CROWI_ENCRYPTION_KEY` specifically it would be a
 * regression: the pre-existing `setupEncryption()` treated a whitespace-only
 * key as configured-but-invalid and threw, not as unset).
 *
 * The returned value IS trimmed, though — every `check.validate` and every
 * derived `values.*` field downstream reads this same trimmed string, so a
 * value that validates (e.g. because a validator itself trims before
 * checking a prefix) can never diverge from the value actually used at boot
 * (previously `MONGO_URI`/`REDIS_URL` with leading/trailing whitespace could
 * pass validation on the trimmed form but reach `setupDatabase()` /
 * `setupRedisClient()` untrimmed).
 */
function resolveRaw(env: NodeJS.ProcessEnv, descriptor: EnvVarDescriptor): { key: string; raw: string } | null {
  const keys = [...(descriptor.aliases ?? []), descriptor.name];
  for (const key of keys) {
    const raw = env[key];
    if (!raw) continue;
    return { key, raw: raw.trim() };
  }
  return null;
}

export interface EnvValidationResult {
  values: {
    /** `BASE_URL`, unchecked (taxonomy-only) — carried over verbatim. */
    baseUrl: string | null;
    /** `NODE_ENV`, defaults to `'production'`. */
    nodeEnv: string;
    /** `PORT`, defaults to `4301`. */
    port: number;
    /** `REDIS_URL` (or an alias), `null` when unset. */
    redisUrl: string | null;
    /** `MONGO_URI` (or an alias), defaults to `'mongodb://localhost/crowi'`. */
    mongoUri: string;
    /**
     * `CROWI_ENCRYPTION_KEY`, trimmed, `null` when genuinely unset. A
     * whitespace-only value is NOT unset (see {@link resolveRaw}) — it fails
     * `CROWI_ENCRYPTION_KEY_DESCRIPTOR.check` and `validateEnv()` throws
     * before this field is ever produced, so by the time a caller sees this
     * result, "invalid" is not a possibility: it's either `null` or an
     * already-validated 32-byte key. Consumed by `Crowi.setupEncryption()`
     * instead of it re-reading `this.env` directly, so "is the key
     * configured" has exactly one answer.
     */
    encryptionKey: string | null;
    /**
     * RFC-0014 phase 1 §5 — fully resolved federated-auth trusted origins
     * (`AUTH_PUBLIC_API_URL` / `AUTH_PUBLIC_WEB_URL`, with the `CLIENT_URL`
     * / same-origin fallback chain already applied — see
     * {@link resolveFederatedAuthPublicUrls}). `null` when unresolvable;
     * this is NOT a boot failure (see that function's doc comment) — a
     * caller (`Crowi.getFederatedAuthPublicUrls()`) treats `null` as
     * "federated auth disabled".
     */
    federatedAuthPublicUrls: { apiUrl: string; webUrl: string } | null;
  };
  /** Human-readable warning strings, for a consolidated boot-time report. Empty when nothing is amiss. */
  warnings: string[];
}

/**
 * Validate every Crowi-owned env var in one pass. Throws a single `Error`
 * (listing every `fail`-severity problem, not just the first) when any
 * required value is malformed; otherwise returns the derived `values` plus
 * any `warn`-severity findings.
 */
export function validateEnv(env: NodeJS.ProcessEnv): EnvValidationResult {
  const failMessages: string[] = [];
  const warnMessages: string[] = [];
  // Every descriptor is resolved exactly once here, then reused below when
  // building `values` — avoids re-running `resolveRaw()` (and re-deciding
  // alias precedence) a second time per derived field.
  const resolvedByDescriptor = new Map<EnvVarDescriptor, ReturnType<typeof resolveRaw>>();

  for (const descriptor of ENV_VAR_DESCRIPTORS) {
    const resolved = resolveRaw(env, descriptor);
    resolvedByDescriptor.set(descriptor, resolved);

    if (!resolved) {
      if (descriptor.warnWhenUnset) {
        warnMessages.push(`${descriptor.name}: ${descriptor.warnWhenUnset}`);
      }
      continue;
    }

    if (!descriptor.check) continue;
    const reason = descriptor.check.validate(resolved.raw);
    if (reason == null) continue;
    const message = `${resolved.key}: ${reason}`;
    const severity = typeof descriptor.check.severity === 'function' ? descriptor.check.severity(env) : descriptor.check.severity;
    if (severity === 'fail') {
      failMessages.push(message);
    } else {
      warnMessages.push(message);
    }
  }

  const keyspaceFailure = detectUnresolvableRedisKeyspace(resolvedByDescriptor);
  if (keyspaceFailure) failMessages.push(keyspaceFailure);

  warnMessages.push(...detectTypoWarnings(env));

  if (failMessages.length > 0) {
    throw new Error(`Invalid environment variable(s) — boot aborted:\n${failMessages.map((m) => `  - ${m}`).join('\n')}`);
  }

  const port = resolvedByDescriptor.get(PORT_DESCRIPTOR)?.raw;

  return {
    values: {
      baseUrl: env.BASE_URL || null,
      nodeEnv: env.NODE_ENV || DEFAULT_NODE_ENV,
      port: port ? Number.parseInt(port, 10) : 4301,
      redisUrl: resolvedByDescriptor.get(REDIS_URL_DESCRIPTOR)?.raw ?? null,
      mongoUri: resolvedByDescriptor.get(MONGO_URI_DESCRIPTOR)?.raw ?? 'mongodb://localhost/crowi',
      encryptionKey: resolvedByDescriptor.get(CROWI_ENCRYPTION_KEY_DESCRIPTOR)?.raw ?? null,
      federatedAuthPublicUrls: resolveFederatedAuthPublicUrls(resolvedByDescriptor),
    },
    warnings: warnMessages,
  };
}
