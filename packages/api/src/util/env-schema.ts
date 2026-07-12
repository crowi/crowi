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
 * list): `WS_TOKEN_SECRET`'s placeholder-rejection logic, `REDIS_URL`
 * connection-time failures (vs. format), `CROWI_ENCRYPTION_KEY`'s runtime
 * re-read in `util/crypto.ts` (`EnvKeyProvider.getKey()`), and module-level
 * constants that are evaluated at `import` time (`util/jwt.ts`,
 * `util/collab-cap.ts`, `hono/handlers/oauth.ts`) — those are registered here
 * as taxonomy (so a typo is at least visible as a warning) but their actual
 * parsing stays where it is.
 */

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
    readonly severity: 'fail' | 'warn';
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

/**
 * Strips a `user:pass@` (or bare `user@`) userinfo segment before a raw URI
 * is echoed into a boot-abort error message. A malformed-scheme
 * `MONGO_URI`/`REDIS_URL` (wrong scheme, typo'd host, ...) can still embed
 * real credentials, and this message reaches an *uncaught* top-level
 * exception (the constructor throws before `app.ts`'s error handler is even
 * installed), so it can end up printed unredacted to stdout/stderr —
 * unlike the pre-existing mongoose driver's own connect-time parse error,
 * which never includes the raw connection string at all.
 */
function redactUserinfo(raw: string): string {
  return raw.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@]*@/, '$1***@');
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

function validateRedisUrl(raw: string): string | null {
  if (!/^rediss?:\/\//.test(raw.trim())) {
    return `must start with "redis://" or "rediss://" (got ${JSON.stringify(redactUserinfo(raw))})`;
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
 * Taxonomy-only variables: registered so typo-detection recognises them (and
 * so a real consumer's own resolution logic isn't duplicated here), but their
 * content is not checked.
 */
const TAXONOMY_ONLY_NAMES = [
  'WS_TOKEN_SECRET',
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
  CROWI_ENCRYPTION_KEY_DESCRIPTOR,
  CLIENT_URL_DESCRIPTOR,
  CROWI_MULTI_INSTANCE_DESCRIPTOR,
  NODE_ENV_DESCRIPTOR,
  JWT_ACCESS_TTL_DESCRIPTOR,
  JWT_REFRESH_TTL_DESCRIPTOR,
  COLLAB_MAX_EDITORS_DESCRIPTOR,
  MIGRATION_POLICY_DESCRIPTOR,
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
const TYPO_PREFIXES = ['CROWI_', 'WS_TOKEN_', 'JWT_', 'COLLAB_', 'REDIS', 'MONGO', 'MIGRATION_'] as const;

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
    if (descriptor.check.severity === 'fail') {
      failMessages.push(message);
    } else {
      warnMessages.push(message);
    }
  }

  warnMessages.push(...detectTypoWarnings(env));

  if (failMessages.length > 0) {
    throw new Error(`Invalid environment variable(s) — boot aborted:\n${failMessages.map((m) => `  - ${m}`).join('\n')}`);
  }

  const port = resolvedByDescriptor.get(PORT_DESCRIPTOR)?.raw;

  return {
    values: {
      baseUrl: env.BASE_URL || null,
      nodeEnv: env.NODE_ENV || 'production',
      port: port ? Number.parseInt(port, 10) : 4301,
      redisUrl: resolvedByDescriptor.get(REDIS_URL_DESCRIPTOR)?.raw ?? null,
      mongoUri: resolvedByDescriptor.get(MONGO_URI_DESCRIPTOR)?.raw ?? 'mongodb://localhost/crowi',
      encryptionKey: resolvedByDescriptor.get(CROWI_ENCRYPTION_KEY_DESCRIPTOR)?.raw ?? null,
    },
    warnings: warnMessages,
  };
}
