import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod/v3';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { AwsConfig } from '@crowi/plugin-aws';
import { CONFIG_VERIFICATION_KEY_PREFIX } from '@crowi/plugin-api';
import type { CrowiPlugin, PluginConfigVerificationResult, PluginContext, StateCell, StorageDriver, VerificationFailureReason } from '@crowi/plugin-api';

const S3StorageConfigSchema = z
  .object({
    bucket: z.string().default(''),
  })
  .strict();

type S3StorageConfig = z.infer<typeof S3StorageConfigSchema>;

export interface S3DriverState {
  client: S3Client;
  bucket: string;
}

const plugin: CrowiPlugin = {
  name: '@crowi/plugin-storage-aws-s3',
  version: '0.1.0-dev',
  requires: ['@crowi/plugin-aws'],
  configSchema: S3StorageConfigSchema,
  adminPlacement: {
    label: 'AWS S3',
    icon: 'cloud',
    // section omitted: derived from registerStorage → 'storage'
  },
  // `bucket` defaults to '' (a valid Zod value) but every StorageDriver
  // method throws via `requireBucket()` below until it's set — see
  // feature-plugin-config-readiness. AWS credentials are intentionally
  // NOT declared here: an empty accessKeyId/secretAccessKey is a valid
  // "use the SDK default credential chain" configuration.
  readiness: {
    registry: 'storage',
    driver: 's3',
    requiredConfigFields: ['bucket'],
  },

  registerStorage: (registry, ctx) => {
    const cell = ctx.state<S3DriverState>(buildState(ctx));
    registry.register('s3', createS3Driver(cell));
    ctx.log.debug('registered s3 storage driver (bucket=%s)', cell.get().bucket || '<unset>');
  },

  reconfigure: (ctx) => {
    const next = buildState(ctx);
    const cell = ctx.state<S3DriverState>(next);
    cell.set(next, { dispose: (prev) => prev.client.destroy() });
    ctx.log.debug('reconfigured s3 storage driver (bucket=%s)', next.bucket || '<unset>');
  },

  // feature-plugin-config-live-verification — snapshot-only, non-blocking.
  // Builds a throwaway `S3DriverState` from the snapshot's own `bucket`
  // plus the `@crowi/plugin-aws` dependency's credentials (never the live
  // hot-reload cell behind `registry`/`ctx.state()`), does a real
  // `put -> get -> delete` round trip through the SAME `StorageDriver`
  // shape the real driver uses, and destroys its one-shot client when
  // done — no persistent connection pool left behind.
  verifyConfig: async (snapshot) => {
    const own = snapshot.config<S3StorageConfig>();
    const aws = snapshot.dependencyConfig<AwsConfig>('@crowi/plugin-aws');
    const state = buildVerificationState(own, aws);
    // `probeS3RoundTrip` itself resolves as soon as `put` has settled — it
    // does NOT wait for `get` to settle before returning (see its own doc):
    // that is what lets `cleanupSettled.finally(destroy)` below get chained
    // even when the read that follows hangs. `verdict` is a promise chained
    // off the same read, so `verifyConfig`'s own returned promise still
    // resolves only once that read settles (or the manager's outer 10s race
    // gives up on it) — nothing here is short-circuited.
    const { verdict, cleanupSettled } = await probeS3RoundTrip(state);
    // Destroy once cleanup has settled (or immediately when `put` itself
    // failed and no cleanup was ever scheduled — `cleanupSettled` is a
    // pre-resolved promise in that case), NOT in an eager `finally` right
    // here: the cleanup delete fires fire-and-forget a few microtasks
    // before this function returns, so destroying the client immediately
    // would abort that still in-flight request on nearly every successful
    // probe. `void` — this must not delay the result `verdict` carries.
    void cleanupSettled.finally(() => state.client.destroy());
    return verdict;
  },
};

export default plugin;

function buildState(ctx: PluginContext): S3DriverState {
  const own = ctx.config<S3StorageConfig>();
  const aws = ctx.dependencyConfig<AwsConfig>('@crowi/plugin-aws');
  return {
    client: new S3Client({
      region: aws.region || undefined,
      credentials:
        aws.accessKeyId && aws.secretAccessKey
          ? {
              accessKeyId: aws.accessKeyId,
              secretAccessKey: aws.secretAccessKey,
            }
          : undefined,
    }),
    bucket: own.bucket,
  };
}

/**
 * Build the storage driver around a hot-reload {@link StateCell}. Each
 * method reads the cell through `withValue()`, which snapshots the
 * state for the duration of the call and protects it from being torn
 * down by a concurrent `reconfigure()` — the next call sees the new
 * client/bucket.
 */
export function createS3Driver(cell: StateCell<S3DriverState>): StorageDriver {
  return {
    async put(key, body, meta) {
      return cell.withValue(async ({ client, bucket }) => {
        requireBucket(bucket);
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body as Buffer | Readable,
            ContentType: meta.contentType,
          }),
        );
        return { key };
      });
    },

    async get(key) {
      return cell.withValue(async ({ client, bucket }) => {
        requireBucket(bucket);
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const body = response.Body;
        if (!body) {
          throw new Error(`S3 returned empty body for key '${key}'`);
        }
        return body as Readable;
      });
    },

    async delete(key) {
      return cell.withValue(async ({ client, bucket }) => {
        requireBucket(bucket);
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      });
    },

    async signedUrl(key, expiresInSec) {
      return cell.withValue(async ({ client, bucket }) => {
        requireBucket(bucket);
        return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: expiresInSec });
      });
    },
  };
}

function requireBucket(bucket: string): void {
  if (!bucket) {
    throw new Error('@crowi/plugin-storage-aws-s3: bucket is not configured.');
  }
}

/**
 * Build a one-shot `S3DriverState` for verification: same credential
 * resolution as `buildState()`, plus `maxAttempts: 1` — a verification
 * probe must not silently retry into the caller's timeout budget
 * (feature-plugin-config-live-verification §3).
 */
function buildVerificationState(own: S3StorageConfig, aws: AwsConfig): S3DriverState {
  return {
    client: new S3Client({
      region: aws.region || undefined,
      credentials:
        aws.accessKeyId && aws.secretAccessKey
          ? {
              accessKeyId: aws.accessKeyId,
              secretAccessKey: aws.secretAccessKey,
            }
          : undefined,
      maxAttempts: 1,
    }),
    bucket: own.bucket,
  };
}

/**
 * Adapt a fixed `S3DriverState` (no hot-reload) into the `StateCell` shape
 * `createS3Driver` expects, so verification reuses the exact same
 * `StorageDriver` implementation the real hot-reload driver uses instead
 * of a parallel one. `set()` is a no-op — a verification driver is used
 * once and discarded, it never reconfigures.
 */
function createS3DriverFromState(state: S3DriverState): StorageDriver {
  const cell: StateCell<S3DriverState> = {
    get: () => state,
    withValue: async (fn) => fn(state),
    set: () => {},
  };
  return createS3Driver(cell);
}

export interface S3RoundTripOutcome {
  /**
   * Chained off the in-flight read, NOT already awaited — resolving
   * `probeS3RoundTrip` itself as soon as `put` has settled (see the
   * function doc) means callers must await this separately from getting
   * the outcome object back.
   */
  verdict: Promise<PluginConfigVerificationResult>;
  /**
   * Resolves once the fire-and-forget cleanup delete has either settled or
   * given up waiting on it (its own independent budget elapsed) — a
   * pre-resolved promise when `put` itself failed and no cleanup was ever
   * scheduled. `verifyConfig` chains the one-shot client's `destroy()` off
   * this (not off `verdict`) so destroying the client doesn't abort the
   * still in-flight cleanup delete.
   */
  cleanupSettled: Promise<void>;
}

/**
 * Runs `put`, then returns immediately with `{ verdict, cleanupSettled }`
 * — it does NOT `await` the subsequent `get`/read before returning.
 * That is deliberate: `get` reading a stalled connection must not also
 * stall `cleanupSettled` (and, through it, `verifyConfig`'s client
 * `destroy()`) — see AC-11 and the identical rationale in
 * `@crowi/plugin-storage-local`'s `probeStorageDriver`. `cleanupTimeoutMs`
 * overrides the cleanup budget for tests; production callers never pass it.
 *
 * Exported (not just used internally) for the same reason
 * `@crowi/plugin-storage-local` exports `probeStorageDriver`: it lets a
 * test exercise the independent-cleanup-budget behaviour directly, with a
 * short overridden budget, instead of waiting out the real 5s default.
 */
export async function probeS3RoundTrip(
  state: S3DriverState,
  cleanupTimeoutMs: number = S3_VERIFICATION_CLEANUP_TIMEOUT_MS,
  // Test-only seam, same rationale as `cleanupTimeoutMs` above — production
  // callers never pass this. Lets a test drive a `put()` that reports a
  // different key than requested without needing a real S3-compatible
  // backend that could actually disagree with itself that way.
  driver: Pick<StorageDriver, 'put' | 'get' | 'delete'> = createS3DriverFromState(state),
): Promise<S3RoundTripOutcome> {
  const key = `${CONFIG_VERIFICATION_KEY_PREFIX}${randomBytes(16).toString('hex')}`;
  const payload = randomBytes(32);

  let putKey: string;
  try {
    ({ key: putKey } = await driver.put(key, payload, { contentType: 'application/octet-stream' }));
  } catch (err) {
    // Nothing was written — no probe object exists yet, so there is
    // nothing to clean up.
    return {
      verdict: Promise.resolve({ status: 'failed', reason: classifyS3Error(err, { afterSuccessfulPut: false }) }),
      cleanupSettled: Promise.resolve(),
    };
  }

  // The probe object now exists in the bucket — schedule its cleanup THIS
  // instant, racing "the read below settles" against the cleanup's own
  // budget (see `scheduleS3VerificationCleanup`), rather than sequencing
  // cleanup strictly after the read finishes. `read` is shared (not
  // re-invoked) by the verdict promise below.
  const read = driver.get(key).then(readAllBuffer);
  const cleanupSettled = scheduleS3VerificationCleanup(driver, key, read, cleanupTimeoutMs);

  const verdict = read.then(
    (bytes): PluginConfigVerificationResult =>
      // A driver reporting success while silently storing under a different
      // key than requested, or returning corrupted bytes, is neither one of
      // the classified driver exceptions — there's no error to classify, so
      // 'unknown' is the honest reason rather than guessing a specific one.
      putKey === key && bytes.equals(payload) ? { status: 'ok' } : { status: 'failed', reason: 'unknown' },
    (err): PluginConfigVerificationResult => ({ status: 'failed', reason: classifyS3Error(err, { afterSuccessfulPut: true }) }),
  );

  return { verdict, cleanupSettled };
}

/** Independent budget for the fire-and-forget cleanup delete — see the identical constant/rationale in `@crowi/plugin-storage-local`. */
const S3_VERIFICATION_CLEANUP_TIMEOUT_MS = 5_000;

/**
 * Fire a cleanup `delete(key)` off, decoupled from both the caller and
 * from `gate` (the in-flight read) ever settling. Triggered by whichever
 * comes first — `gate` settling (read normally already done by then) or
 * `timeoutMs` elapsing — then calls `driver.delete(key)` and returns a
 * promise that resolves once THAT settles too; `verifyConfig` uses it only
 * to know when destroying the one-shot client is safe (see its call site),
 * never to gate or delay `verdict`. A delete failure is logged only and
 * never surfaces.
 *
 * Deliberately NOT `Promise.race([gateSettled, budgetElapsed])` — see the
 * identical rationale (and the microtask-timing test it protects) in
 * `@crowi/plugin-storage-local`'s `scheduleVerificationCleanup`: attaching
 * `trigger` directly to `gate` fires it in the very same microtask turn
 * `gate`'s settlement is observed, rather than a few hops later.
 */
function scheduleS3VerificationCleanup(driver: Pick<StorageDriver, 'delete'>, key: string, gate: Promise<unknown>, timeoutMs: number): Promise<void> {
  let triggered = false;
  let timer: ReturnType<typeof setTimeout>;
  let resolveSettled: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });

  const trigger = (): void => {
    if (triggered) return;
    triggered = true;
    clearTimeout(timer);
    driver.delete(key).then(resolveSettled, () => {
      // No error detail logged — an S3 SDK exception can embed the
      // bucket/endpoint/credentials it was talking to (§3's no-raw-
      // error-data contract).
      console.warn('[crowi:plugin:@crowi/plugin-storage-aws-s3] verification cleanup delete failed.');
      resolveSettled();
    });
  };
  timer = setTimeout(trigger, timeoutMs);
  timer.unref?.();
  void gate.then(trigger, trigger);

  return settled;
}

async function readAllBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Classify an S3 SDK failure into the fixed reason set
 * (feature-plugin-config-live-verification §3's table). `afterSuccessfulPut`
 * distinguishes the one context-dependent row: `AccessDenied` on the
 * initial `put` means the credentials can't write at all (`'auth-failed'`),
 * but the SAME error name on the `get` that follows a successful `put`
 * means the object was written yet can't be read back (`'write-denied'`).
 * Anything not explicitly in the table falls into `'unknown'`.
 */
export function classifyS3Error(err: unknown, opts: { afterSuccessfulPut: boolean }): VerificationFailureReason {
  const name = (err as { name?: unknown } | undefined)?.name;
  if (name === 'NoSuchBucket') return 'resource-missing';
  if (name === 'AccessDenied') return opts.afterSuccessfulPut ? 'write-denied' : 'auth-failed';
  if (name === 'InvalidAccessKeyId' || name === 'SignatureDoesNotMatch') return 'auth-failed';
  if (isConnectionError(err)) return 'unreachable';
  return 'unknown';
}

const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT']);

/** Connection-level failures surface as a Node errno code, either directly on the thrown error or on its `.cause` (the AWS SDK v3 HTTP handler wraps the underlying `node:http`/TLS error). */
function isConnectionError(err: unknown): boolean {
  const direct = (err as NodeJS.ErrnoException | undefined)?.code;
  if (direct && CONNECTION_CODES.has(direct)) return true;
  const cause = (err as { cause?: unknown } | undefined)?.cause as NodeJS.ErrnoException | undefined;
  return !!cause?.code && CONNECTION_CODES.has(cause.code);
}
