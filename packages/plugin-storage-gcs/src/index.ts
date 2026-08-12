import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Storage, type Bucket } from '@google-cloud/storage';
import { z } from 'zod/v3';
import type { CrowiPlugin, PluginContext, StateCell, StorageDriver } from '@crowi/plugin-api';

/** The stable driver name (`crowi.config.json:storage.driver`) and this package's npm name — both identifiers callers depend on. */
const GCS_DRIVER_NAME = 'gcs';

// ---------------------------------------------------------------------------
// config schema
// ---------------------------------------------------------------------------

const PREFIX_INVALID_SEGMENTS_MESSAGE = 'Prefix must not contain empty, ".", or ".." segments';

export const GcsStorageConfigSchema = z
  .object({
    bucket: z.string().trim().describe('GCS bucket').default(''),
    prefix: z
      .string()
      .trim()
      .superRefine((value, ctx) => {
        if (!isValidNormalizedPrefix(normalizePrefix(value))) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: PREFIX_INVALID_SEGMENTS_MESSAGE });
        }
      })
      .describe('Object prefix')
      .default(''),
    projectId: z.string().trim().describe('Google Cloud project ID').default(''),
    // No `.trim()`: an empty-or-whitespace value means "use ADC" (see
    // `parseServiceAccountKey`), and the raw bytes otherwise round-trip into
    // JSON.parse verbatim — trimming here would just be dead code the
    // validator already has to tolerate either way.
    serviceAccountKey: z
      .string()
      .superRefine((raw, ctx) => {
        const result = parseServiceAccountKey(raw);
        if (result.mode === 'invalid') {
          for (const message of result.issues) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message });
          }
        }
      })
      .describe('@sensitive Google Cloud service-account key JSON')
      .default(''),
  })
  .strict();

export type GcsStorageConfig = z.infer<typeof GcsStorageConfigSchema>;

// ---------------------------------------------------------------------------
// service-account key parsing / validation
// ---------------------------------------------------------------------------

export interface GcsServiceAccountCredentials {
  project_id: string;
  client_email: string;
  private_key: string;
}

type ParsedServiceAccountKey = { mode: 'adc' } | { mode: 'inline'; credentials: GcsServiceAccountCredentials } | { mode: 'invalid'; issues: string[] };

/**
 * Single source of truth for `serviceAccountKey` validation, shared by the
 * schema's `superRefine` (issues only) and `buildState` (needs the parsed
 * credentials too) — see the design note on `GcsStorageConfigSchema`.
 *
 * Never logs or includes the raw/parsed value in any returned message.
 */
export function parseServiceAccountKey(raw: string): ParsedServiceAccountKey {
  if (raw.trim() === '') return { mode: 'adc' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { mode: 'invalid', issues: ['Must be valid JSON object'] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { mode: 'invalid', issues: ['Must be valid JSON object'] };
  }

  const obj = parsed as Record<string, unknown>;
  const issues: string[] = [];
  if (obj.type !== 'service_account') issues.push('type must be "service_account"');

  const projectId = typeof obj.project_id === 'string' ? obj.project_id : '';
  const clientEmail = typeof obj.client_email === 'string' ? obj.client_email : '';
  const privateKey = typeof obj.private_key === 'string' ? obj.private_key : '';

  if (projectId.length === 0) issues.push('project_id is required');
  if (clientEmail.length === 0) issues.push('client_email is required');
  if (privateKey.length === 0) {
    issues.push('private_key is required');
  } else if (!isPemPrivateKeyBlock(privateKey)) {
    issues.push('private_key must be a PEM private-key block');
  }

  if (issues.length > 0) return { mode: 'invalid', issues };
  return { mode: 'inline', credentials: { project_id: projectId, client_email: clientEmail, private_key: privateKey } };
}

/**
 * The trimmed value must itself BE a PEM private-key block — matching
 * `-----BEGIN ...PRIVATE KEY-----` / `-----END ...PRIVATE KEY-----` labels
 * (e.g. plain `PRIVATE KEY` or `RSA PRIVATE KEY`), non-empty body — not
 * merely contain one as a substring. `^`/`$` anchor the match to the whole
 * (trimmed) string so `junk` around an otherwise-valid block is rejected.
 */
function isPemPrivateKeyBlock(value: string): boolean {
  const match = value.trim().match(/^-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----([\s\S]*?)-----END ([A-Z0-9 ]*PRIVATE KEY)-----$/);
  return match !== null && match[1] === match[3] && match[2].trim().length > 0;
}

// ---------------------------------------------------------------------------
// prefix / physical object name
// ---------------------------------------------------------------------------

/** Strip leading/trailing `/` — the only normalization the prefix gets. Does not trim whitespace (the schema already does that) or touch interior segments. */
export function normalizePrefix(prefix: string): string {
  return prefix.replace(/^\/+/, '').replace(/\/+$/, '');
}

function isValidNormalizedPrefix(normalized: string): boolean {
  if (normalized === '') return true;
  return normalized.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * The one mapping from (normalized prefix, caller-owned logical key) to the
 * physical GCS object name — every operation (`put`/`get`/`delete`/`signedUrl`)
 * goes through this. The logical key itself is never trimmed, URL-encoded, or
 * path-normalized (`StorageDriver`'s round-trip contract).
 */
export function objectName(prefix: string, key: string): string {
  const physical = prefix ? `${prefix}/${key}` : key;
  assertValidObjectName(physical);
  return physical;
}

function assertValidObjectName(name: string): void {
  const byteLength = Buffer.byteLength(name, 'utf8');
  if (byteLength < 1 || byteLength > 1024) {
    throw new Error('GCS object name must be between 1 and 1024 UTF-8 bytes');
  }
}

function assertValidSignedUrlExpiry(expiresInSec: number): void {
  if (!Number.isInteger(expiresInSec) || expiresInSec < 1 || expiresInSec > 604800) {
    throw new Error('Signed URL expiry must be an integer between 1 and 604800 seconds');
  }
}

// ---------------------------------------------------------------------------
// get() streaming handshake and missing-object classification
// ---------------------------------------------------------------------------

/**
 * How long `get()` waits for the download's first readable chunk, EOF, or
 * error before treating the request as hung and failing it. Bounds the time
 * a caller can be left waiting on a request GCS never responds to.
 */
const INITIAL_STREAM_TIMEOUT_MS = 10_000;

/** GCS's `ApiError#code` is the numeric HTTP status (`404`), not the string `'NoSuchKey'`/`'ENOENT'` core's classifier recognizes. */
function isGcsNotFoundError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 404;
}

/**
 * Converts a GCS 404 into the `code: 'ENOENT'` shape `StorageDriver.get`'s
 * TSDoc promises (the same shape the local driver already throws), so
 * core's unmodified `isMissingFileError` classifier treats it as missing
 * exactly like local/S3. Every other error (403, credential, network,
 * mid-stream) passes through unchanged. The original `ApiError` is kept as
 * `cause` for diagnostics; the message IS the logical key — nothing else,
 * never provider error detail — matching spec §5's "missing object の意味論
 * を既存 local / S3 に揃える".
 */
function toGetError(err: unknown, key: string): unknown {
  if (!isGcsNotFoundError(err)) return err;
  return Object.assign(new Error(key), { code: 'ENOENT', cause: err });
}

/**
 * Resolves once the download either produced its first readable chunk,
 * reached a genuine EOF (no non-2xx response ever observed), or failed —
 * never on the `response` event alone, and never on `end` once a non-2xx
 * `response` has been seen. SDK 7.21.0's `File#createReadStream()` can emit
 * a non-2xx `response` and only translate it into a stream `error`
 * afterwards (its `onResponse`/`util.handleResp` internals), so treating
 * `response` as success evidence would report a 404/403 object as a
 * successful download — and treating a subsequent `end` as success would
 * make the same mistake one tick later if the SDK's `error` never arrives.
 *
 * Listeners are attached BEFORE `resume()` starts the request (the stream
 * `createReadStream()` returns stays idle until then, via its own
 * `'reading'` -> request wiring), so no byte can arrive unobserved. At most
 * one `data` chunk is ever buffered: if it arrives before `response`, it is
 * held and the source is re-paused; once a 2xx `response` is confirmed,
 * that held chunk (or the next `data`, if `response` arrived first) is
 * written to the returned `PassThrough` relay and the rest of the stream is
 * piped into it — backpressure past this point is the pipe/relay's job, not
 * this function's. A non-2xx `response` never resolves or rejects by
 * itself, and neither does a subsequent `end`; this function waits for the
 * SDK's own subsequent `error` (or the initial timeout), which `toGetError`
 * then classifies.
 */
function waitForInitialChunkOrEof(source: Readable, key: string): Promise<Readable> {
  return new Promise<Readable>((resolve, reject) => {
    let settled = false;
    let heldChunk: Buffer | null = null;
    let responseOk = false;
    // Set when a non-2xx `response` was observed and never itself resolved
    // (see `onResponse`). Blocks `onEnd`'s success path: if the SDK reaches
    // EOF without ever emitting the `error` that normally follows a non-2xx
    // response, this must NOT be reported as an empty successful download —
    // it keeps waiting for `onError` or the initial timeout instead.
    let sawNonOkResponse = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      source.destroy();
      reject(new Error(`GCS get timed out waiting for the initial response for key '${key}'`));
    }, INITIAL_STREAM_TIMEOUT_MS);

    function cleanup(): void {
      clearTimeout(timer);
      source.removeListener('error', onError);
      source.removeListener('response', onResponse);
      source.removeListener('data', onData);
      source.removeListener('end', onEnd);
    }

    function resolveWithChunk(chunk: Buffer | null): void {
      settled = true;
      cleanup();
      const relay = new PassThrough();
      if (chunk) relay.write(chunk);
      // `.pipe()` does not forward the source's own `error` events to its
      // destination (a well-known Node.js stream gotcha) — do it explicitly
      // so a post-handshake failure surfaces as the RELAY's `error` event
      // (a "downstream error", per the design note on `get`) instead of an
      // unhandled error on `source`.
      source.on('error', (err) => relay.destroy(err));
      source.pipe(relay);
      resolve(relay);
    }

    function resolveEmpty(): void {
      settled = true;
      cleanup();
      const relay = new PassThrough();
      relay.end();
      resolve(relay);
    }

    function onError(err: unknown): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(toGetError(err, key));
    }

    function onResponse(response: { statusCode?: number }): void {
      if (settled) return;
      const statusCode = response.statusCode ?? 0;
      if (statusCode < 200 || statusCode >= 300) {
        sawNonOkResponse = true;
        return; // wait for the SDK's own `error`, never resolve/reject on `response` alone.
      }
      responseOk = true;
      if (heldChunk !== null) resolveWithChunk(heldChunk);
      // else: still waiting for the first `data` (already resumed) or `end`.
    }

    function onData(chunk: Buffer): void {
      if (settled) return;
      if (responseOk) {
        resolveWithChunk(chunk);
        return;
      }
      heldChunk = chunk;
      source.pause();
    }

    function onEnd(): void {
      if (settled) return;
      // A non-2xx response was observed but the SDK never followed it with
      // its own `error` — do not resolve as an empty success; stay pending
      // for `onError` (still wired) or the initial timeout to fire.
      if (sawNonOkResponse) return;
      resolveEmpty();
    }

    source.on('error', onError);
    source.on('response', onResponse);
    source.on('data', onData);
    source.on('end', onEnd);
    source.resume();
  });
}

// ---------------------------------------------------------------------------
// driver state (ADC-first client construction, hot reconfigure)
// ---------------------------------------------------------------------------

export interface GcsDriverState {
  storage: Storage;
  bucket: Bucket;
  bucketName: string;
  prefix: string;
  credentialMode: 'adc' | 'inline';
}

/**
 * Registered when `bucket` is empty (a valid, schema-defaulted config) — the
 * driver exists so readiness/config surfaces work, but every operation
 * rejects with a configuration error until an operator sets a bucket.
 */
export interface UnavailableGcsDriverState {
  bucketName: string;
}

export type GcsState = GcsDriverState | UnavailableGcsDriverState;

function isAvailable(state: GcsState): state is GcsDriverState {
  return 'storage' in state;
}

/**
 * Builds the next `GcsState` from the plugin's current config. Only called
 * after `ctx.config()` has already parsed successfully — invalid stored
 * config throws from `ctx.config()` itself and never reaches here (the
 * plugin fails activation entirely; see the design note in the spec's
 * "hot reconfigure と resource lifecycle" section).
 */
function buildState(ctx: PluginContext): GcsState {
  const config = ctx.config<GcsStorageConfig>();
  const prefix = normalizePrefix(config.prefix);

  if (!config.bucket) {
    return { bucketName: '' };
  }

  const keyResult = parseServiceAccountKey(config.serviceAccountKey);
  if (keyResult.mode === 'invalid') {
    // Defense in depth only: `ctx.config()` already parsed `serviceAccountKey`
    // through the same validator successfully, so this should be
    // unreachable. Fail closed rather than build a client from an
    // unvalidated credential.
    throw new Error('@crowi/plugin-storage-gcs: stored serviceAccountKey failed validation');
  }

  const storage =
    keyResult.mode === 'adc'
      ? new Storage(config.projectId ? { projectId: config.projectId } : {})
      : new Storage({
          projectId: config.projectId || keyResult.credentials.project_id,
          credentials: { client_email: keyResult.credentials.client_email, private_key: keyResult.credentials.private_key },
        });

  ctx.log.debug('gcs storage driver ready (bucket=%s prefix=%s credentialMode=%s)', config.bucket, prefix || '<none>', keyResult.mode);

  return {
    storage,
    bucket: storage.bucket(config.bucket),
    bucketName: config.bucket,
    prefix,
    credentialMode: keyResult.mode,
  };
}

function requireAvailable(state: GcsState): GcsDriverState {
  if (!isAvailable(state)) {
    throw new Error('@crowi/plugin-storage-gcs: bucket is not configured.');
  }
  return state;
}

/**
 * Build the storage driver around a hot-reload {@link StateCell} — same
 * snapshot-via-`withValue()` shape as `@crowi/plugin-storage-aws-s3`'s
 * `createS3Driver`.
 */
export function createGcsDriver(cell: StateCell<GcsState>): StorageDriver {
  return {
    async put(key, body, meta) {
      return cell.withValue(async (state) => {
        const { bucket, prefix } = requireAvailable(state);
        const name = objectName(prefix, key);
        const source = body instanceof Buffer ? Readable.from(body) : body;
        await pipeline(source, bucket.file(name).createWriteStream({ resumable: false, metadata: { contentType: meta.contentType } }));
        return { key };
      });
    },

    async get(key) {
      return cell.withValue(async (state) => {
        const { bucket, prefix } = requireAvailable(state);
        const name = objectName(prefix, key);
        const source = bucket.file(name).createReadStream();
        return waitForInitialChunkOrEof(source, key);
      });
    },

    async delete(key) {
      return cell.withValue(async (state) => {
        const { bucket, prefix } = requireAvailable(state);
        const name = objectName(prefix, key);
        // `StorageDriver.delete`'s contract is idempotent (no-op if the key
        // is already absent) — same as local's `rm(..., { force: true })`
        // and S3's `DeleteObject`. `Attachment.findOneAndDelete` also runs
        // BEFORE `deleteFile`, so a reject here on a missing object would
        // 500 after the Mongo row is already gone.
        await bucket.file(name).delete({ ignoreNotFound: true });
      });
    },

    async signedUrl(key, expiresInSec) {
      return cell.withValue(async (state) => {
        const { bucket, prefix } = requireAvailable(state);
        assertValidSignedUrlExpiry(expiresInSec);
        const name = objectName(prefix, key);
        const [url] = await bucket.file(name).getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + expiresInSec * 1000 });
        return url;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// plugin registration
// ---------------------------------------------------------------------------

const plugin: CrowiPlugin = {
  name: '@crowi/plugin-storage-gcs',
  version: '0.1.0-alpha.0',

  configSchema: GcsStorageConfigSchema,

  // All four fields are stored as ONE encrypted atomic string-map document
  // rather than four rows — see `GcsStorageConfigSchema`'s `serviceAccountKey`
  // and `packages/plugin-google/src/index.ts`'s `clientCredentials` group for
  // the same at-rest-indivisibility rationale (RFC-0014 phase 4).
  configAtomicGroups: [{ name: 'gcsConnection', keys: ['bucket', 'prefix', 'projectId', 'serviceAccountKey'], sensitive: true }],

  adminPlacement: { label: 'Google Cloud Storage', icon: 'cloud' },

  configI18n: {
    en: {
      bucket: { label: 'GCS bucket', description: 'Existing private bucket name. Crowi does not create buckets.' },
      prefix: { label: 'Object prefix', description: 'Optional prefix prepended to every Crowi object key.' },
      projectId: {
        label: 'Google Cloud project ID',
        description: 'Optional explicit project ID; leave blank to use ADC or the inline key project.',
      },
      serviceAccountKey: {
        label: 'Service account key JSON',
        description: 'Optional encrypted fallback. Leave blank to use Application Default Credentials.',
      },
    },
    ja: {
      bucket: { label: 'GCS バケット', description: '既存の非公開バケット名。Crowi はバケットを作成しません。' },
      prefix: { label: 'オブジェクトプレフィックス', description: 'すべての Crowi オブジェクトキーの先頭に付ける任意のプレフィックス。' },
      projectId: {
        label: 'Google Cloud プロジェクト ID',
        description: '任意の明示的プロジェクト ID。ADC または inline key のプロジェクトを使う場合は空欄。',
      },
      serviceAccountKey: {
        label: 'サービスアカウントキー JSON',
        description: '暗号化される任意の fallback。Application Default Credentials を使う場合は空欄。',
      },
    },
  },

  // `bucket` defaults to '' (a valid Zod value) but every StorageDriver
  // method throws via `requireAvailable()` above until it's set — same
  // readiness/per-operation-error split as `@crowi/plugin-storage-aws-s3`.
  readiness: {
    registry: 'storage',
    driver: GCS_DRIVER_NAME,
    requiredConfigFields: ['bucket'],
  },

  registerStorage: (registry, ctx) => {
    const cell = ctx.state<GcsState>(buildState(ctx));
    registry.register(GCS_DRIVER_NAME, createGcsDriver(cell));
    ctx.log.debug('registered gcs storage driver (bucket=%s)', cell.get().bucketName || '<unset>');
  },

  reconfigure: (ctx) => {
    const next = buildState(ctx);
    const cell = ctx.state<GcsState>(next);
    // `Storage` has no documented close/destroy API (unlike `S3Client`), so
    // there is no `dispose` callback here — the previous client is simply
    // dropped once nothing references it anymore.
    cell.set(next);
    ctx.log.debug('reconfigured gcs storage driver (bucket=%s)', next.bucketName || '<unset>');
  },
};

export default plugin;
