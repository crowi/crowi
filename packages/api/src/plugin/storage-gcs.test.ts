/**
 * `@crowi/plugin-storage-gcs` tests — Phase 1 (package skeleton and config,
 * AC-1/AC-2/AC-3): config schema (bucket/prefix/projectId/serviceAccountKey),
 * the `gcsConnection` atomic group, admin placement/i18n, ADC-vs-inline
 * client construction, prefix/object-name mapping, and valid-config-only
 * activation — including activation FAILING closed (never reaching
 * `registry.register`) for malformed stored config, an unknown flat field,
 * or an invalid prefix, exactly like real `PluginManager.activate()` (see
 * `makeCtx` below, which now runs `config()` through the real schema like
 * `createPluginContext` does, instead of returning the fixture verbatim).
 *
 * Also covers the `get()` streaming handshake and 404->ENOENT missing-object
 * conversion (AC-5/AC-6) and the full `delete()` matrix — existing object,
 * absent object (idempotent no-op), and permission/credential/network
 * failure propagation (AC-7): these were pulled forward from Phase 2 because
 * a `get`/`delete` that is already exposed on the registered driver must
 * honor `StorageDriver`'s missing-object contract now, not later. The REST
 * of Phase 2 — full put-pipeline durability assertions, signedUrl edge cases
 * beyond TTL bounds, StateCell in-flight-vs-new snapshot behavior, and
 * storage-copy — still belongs to a later implementer pass and is not
 * covered here.
 *
 * The GCS SDK is mocked at the module boundary (same pattern as
 * `storage-aws-s3.test.ts`'s `@aws-sdk/client-s3` mock) so we can observe
 * what `new Storage(...)` was constructed with, which physical object name
 * each driver method used, and drive a fake `createReadStream()` through the
 * exact response/data/end/error event sequence SDK 7.21.0 uses — without
 * touching real GCP.
 */
import type { Readable } from 'node:stream';
import type { PluginContext, StorageDriver, StorageRegistry } from '@crowi/plugin-api';
import gcsPlugin, {
  GcsStorageConfigSchema,
  type GcsServiceAccountCredentials,
  type GcsState,
  createGcsDriver,
  normalizePrefix,
  objectName,
  parseServiceAccountKey,
} from '@crowi/plugin-storage-gcs';
import { isMissingFileError } from '../util/file-uploader';
import { makeSharedPluginState } from './state-cell-test-support';

const VALID_PEM = '-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEA\n-----END PRIVATE KEY-----\n';
const validKeyJson = (overrides: Partial<GcsServiceAccountCredentials & { type: string }> = {}) =>
  JSON.stringify({
    type: 'service_account',
    project_id: 'key-project',
    client_email: 'sa@key-project.iam.gserviceaccount.com',
    private_key: VALID_PEM,
    ...overrides,
  });

interface FakeFileHandle {
  name: string;
  createWriteStream: jest.Mock;
  createReadStream: jest.Mock<Readable, []>;
  delete: jest.Mock;
  getSignedUrl: jest.Mock;
}

interface FakeBucketHandle {
  name: string;
  file: jest.Mock<FakeFileHandle, [string]>;
}

// Tracking arrays are only ever pushed into from inside a mock class's
// constructor/method body — i.e. lazily, at test-run time (when the code
// under test calls `new Storage(...)`/`storage.bucket(...)`), never at
// module-load time — so it does not matter that they are declared textually
// after `jest.mock()`; see the comment on the mock factory below for why the
// classes themselves CANNOT live out here.
let constructedStorageOptions: Array<Record<string, unknown> | undefined> = [];
let constructedBuckets: FakeBucketHandle[] = [];

// The mock classes are defined INSIDE the factory (not referenced from
// outer-scope `class` declarations) because Jest hoists `jest.mock()` calls
// above this file's own `import` statements, but the factory function body
// itself only runs later, when `@crowi/plugin-storage-gcs`'s own
// `import { Storage } from '@google-cloud/storage'` actually requires this
// module — which happens as soon as THIS file's `import gcsPlugin from
// '@crowi/plugin-storage-gcs'` resolves, i.e. before any later `class ...`
// statement in this file has executed. Referencing such a class directly
// from the factory's own top-level body hits the TDZ; referencing plain
// `let` arrays from inside a lazily-invoked constructor does not.
jest.mock('@google-cloud/storage', () => {
  const { Readable, Writable } = require('node:stream');

  // Drives the same event sequence SDK 7.21.0's `File#createReadStream()`
  // actually emits (verified against `file.js`'s `onResponse`/
  // `util.handleResp`): a `response` event fires first (success OR
  // failure), and only afterwards — via `destroy(err)` — does a non-2xx
  // response become an `error`. Tests call `.push()`/`.emit('response', …)`/
  // `.destroy(err)` directly to script each scenario; `_read` is a no-op
  // because everything is pushed externally.
  class FakeGcsReadStream extends Readable {
    _read() {}
  }

  class FakeFile implements FakeFileHandle {
    constructor(public readonly name: string) {}
    createWriteStream = jest.fn(() => new Writable({ write: (_chunk: unknown, _enc: unknown, cb: () => void) => cb() }));
    createReadStream = jest.fn(() => new FakeGcsReadStream());
    delete = jest.fn(async (_options?: unknown) => undefined);
    getSignedUrl = jest.fn(async () => ['https://signed.example/fake']);
  }

  class FakeBucket implements FakeBucketHandle {
    private readonly filesByName = new Map<string, FakeFile>();
    constructor(public readonly name: string) {}
    file = jest.fn((name: string) => {
      let f = this.filesByName.get(name);
      if (!f) {
        f = new FakeFile(name);
        this.filesByName.set(name, f);
      }
      return f;
    });
  }

  class FakeStorage {
    constructor(public readonly opts?: Record<string, unknown>) {
      constructedStorageOptions.push(opts);
    }
    bucket = jest.fn((name: string) => {
      const b = new FakeBucket(name);
      constructedBuckets.push(b);
      return b;
    });
  }

  return { Storage: FakeStorage };
});

const sharedPluginState = makeSharedPluginState();

// Populated by `register()`'s fake registry — name + driver for every
// `registry.register(...)` call `registerStorage` made, in order. Reset in
// `beforeEach` (not by `register()` itself) so an activation-failure test
// can assert it stayed EMPTY after a throwing `register()` call.
let registerCalls: Array<{ name: string; driver: StorageDriver }> = [];

function makeCtx(own: Record<string, unknown>): PluginContext {
  return {
    config: () => {
      // Mirrors `createPluginContext.config()` (`plugin-context.ts`): the
      // real activation-time context runs the stored namespace through
      // `plugin.configSchema.safeParse(...)` and THROWS on failure — it
      // never hands the plugin invalid data. `PluginManager.activateAll()`
      // catches that throw per-plugin, so `registerStorage` (and therefore
      // `registry.register`) never runs for an invalid stored config; the
      // plugin is excluded from `loadedPlugins` and never appears on the
      // admin plugin config surface (design section 6).
      const result = GcsStorageConfigSchema.safeParse(own);
      if (!result.success) {
        throw new Error(`Plugin '@crowi/plugin-storage-gcs' config validation failed: ${result.error.message}`);
      }
      return result.data as unknown as never;
    },
    dependencyConfig: () => {
      throw new Error('not used');
    },
    appInfo: () => ({ title: 'Crowi', baseUrl: '' }),
    setConfig: jest.fn(),
    pageMetadata: { get: jest.fn(), set: jest.fn(), remove: jest.fn() },
    model: () => ({}),
    log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    state: sharedPluginState.state,
  };
}

function register(ctx: PluginContext): StorageDriver {
  // `StorageRegistry` has exactly one method, so this fake satisfies the
  // real interface outright — no `any`/cast needed.
  const fakeRegistry: StorageRegistry = {
    register: (name: string, driver: StorageDriver) => {
      registerCalls.push({ name, driver });
    },
  };
  gcsPlugin.registerStorage?.(fakeRegistry, ctx);
  const last = registerCalls.at(-1);
  if (!last) throw new Error('registerStorage did not register a driver');
  return last.driver;
}

function registerWithPrefix(prefix: string): { driver: StorageDriver; bucket: FakeBucketHandle } {
  const driver = register(makeCtx({ bucket: 'b', prefix, projectId: '', serviceAccountKey: '' }));
  const bucket = constructedBuckets.at(-1);
  if (!bucket) throw new Error('expected a bucket to have been constructed');
  return { driver, bucket };
}

/** The fake read stream `createReadStream()` most recently returned for `bucket` — i.e. the one behind the in-flight `driver.get(...)` call the test just started. */
function lastCreatedReadStream(bucket: FakeBucketHandle): Readable {
  const lastFile = bucket.file.mock.results.at(-1)?.value as FakeFileHandle | undefined;
  if (!lastFile) throw new Error('expected bucket.file() to have been called');
  const lastStream = lastFile.createReadStream.mock.results.at(-1)?.value;
  if (!lastStream) throw new Error('expected createReadStream() to have been called');
  return lastStream;
}

/** Drives the fake stream through a normal 2xx download: `response` -> optional `data` -> `end`. */
function completeSuccessfulRead(bucket: FakeBucketHandle, chunk?: Buffer): void {
  const stream = lastCreatedReadStream(bucket);
  stream.emit('response', { statusCode: 200 });
  if (chunk && chunk.length > 0) stream.push(chunk);
  stream.push(null);
}

beforeEach(() => {
  constructedStorageOptions = [];
  constructedBuckets = [];
  registerCalls = [];
  sharedPluginState.reset();
});

describe('@crowi/plugin-storage-gcs — plugin metadata (AC-1, AC-2)', () => {
  it('declares the stable name/version and admin placement', () => {
    expect(gcsPlugin.name).toBe('@crowi/plugin-storage-gcs');
    expect(gcsPlugin.version).toBe('0.1.0-alpha.0');
    expect(gcsPlugin.adminPlacement).toEqual({ label: 'Google Cloud Storage', icon: 'cloud' });
  });

  it('declares bucket as the sole readiness field for the gcs driver', () => {
    expect(gcsPlugin.readiness).toEqual({ registry: 'storage', driver: 'gcs', requiredConfigFields: ['bucket'] });
  });

  it('declares the gcsConnection atomic group over all four fields, marked sensitive', () => {
    expect(gcsPlugin.configAtomicGroups).toEqual([{ name: 'gcsConnection', keys: ['bucket', 'prefix', 'projectId', 'serviceAccountKey'], sensitive: true }]);
  });

  it('declares the exact ja/en configI18n table from the spec', () => {
    expect(gcsPlugin.configI18n).toEqual({
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
    });
  });
});

describe('GcsStorageConfigSchema (AC-1, AC-2)', () => {
  it('defaults every field to an empty string', () => {
    expect(GcsStorageConfigSchema.parse({})).toEqual({ bucket: '', prefix: '', projectId: '', serviceAccountKey: '' });
  });

  it('trims bucket/prefix/projectId but not serviceAccountKey', () => {
    const parsed = GcsStorageConfigSchema.parse({ bucket: '  b  ', prefix: '  p  ', projectId: '  proj  ', serviceAccountKey: '   ' });
    expect(parsed.bucket).toBe('b');
    expect(parsed.prefix).toBe('p');
    expect(parsed.projectId).toBe('proj');
    // Whitespace-only is left as-is (still empty/ADC once .trim()'d by parseServiceAccountKey internally).
    expect(parsed.serviceAccountKey).toBe('   ');
  });

  it('accepts an empty serviceAccountKey (ADC)', () => {
    expect(GcsStorageConfigSchema.safeParse({ serviceAccountKey: '' }).success).toBe(true);
  });

  it('accepts a whitespace-only serviceAccountKey (ADC)', () => {
    expect(GcsStorageConfigSchema.safeParse({ serviceAccountKey: '   ' }).success).toBe(true);
  });

  it('accepts a valid service-account key JSON', () => {
    expect(GcsStorageConfigSchema.safeParse({ serviceAccountKey: validKeyJson() }).success).toBe(true);
  });

  it('rejects invalid JSON with a single issue', () => {
    const result = GcsStorageConfigSchema.safeParse({ serviceAccountKey: 'not json' });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.issues).toEqual([{ code: 'custom', message: 'Must be valid JSON object', path: ['serviceAccountKey'] }]);
  });

  it('rejects a JSON array (valid JSON, not a non-null object) as "Must be valid JSON object"', () => {
    const result = GcsStorageConfigSchema.safeParse({ serviceAccountKey: '[]' });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.issues.map((i) => i.message)).toEqual(['Must be valid JSON object']);
  });

  it('rejects a wrong "type" with its own issue', () => {
    const result = GcsStorageConfigSchema.safeParse({ serviceAccountKey: validKeyJson({ type: 'not_a_service_account' }) });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.issues.map((i) => i.message)).toEqual(['type must be "service_account"']);
  });

  it('returns one issue per missing required field when several are absent at once', () => {
    const result = GcsStorageConfigSchema.safeParse({
      serviceAccountKey: JSON.stringify({ type: 'service_account' }),
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.issues.map((i) => i.message)).toEqual(['project_id is required', 'client_email is required', 'private_key is required']);
    for (const issue of result.error.issues) {
      expect(issue.path).toEqual(['serviceAccountKey']);
    }
  });

  it('rejects a private_key that is not a PEM block', () => {
    const result = GcsStorageConfigSchema.safeParse({ serviceAccountKey: validKeyJson({ private_key: 'not-a-pem-block' }) });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.issues.map((i) => i.message)).toEqual(['private_key must be a PEM private-key block']);
  });

  it('rejects a private_key whose BEGIN/END labels do not match', () => {
    const badPem = '-----BEGIN PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----';
    const result = GcsStorageConfigSchema.safeParse({ serviceAccountKey: validKeyJson({ private_key: badPem }) });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.issues.map((i) => i.message)).toEqual(['private_key must be a PEM private-key block']);
  });

  it('rejects a private_key that merely CONTAINS a valid PEM block as a substring, surrounded by junk', () => {
    const wrapped = `junk${VALID_PEM.trim()}junk`;
    const result = GcsStorageConfigSchema.safeParse({ serviceAccountKey: validKeyJson({ private_key: wrapped }) });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.issues.map((i) => i.message)).toEqual(['private_key must be a PEM private-key block']);
  });

  it('never echoes the raw key or parsed credentials in a validation message', () => {
    const secret = validKeyJson({ private_key: 'not-a-pem-block-but-secret-shaped-xyz123' });
    const result = GcsStorageConfigSchema.safeParse({ serviceAccountKey: secret });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    const serialized = JSON.stringify(result.error.issues);
    expect(serialized).not.toContain('xyz123');
    expect(serialized).not.toContain('sa@key-project');
  });

  it('rejects a prefix with an empty segment ("//")', () => {
    const result = GcsStorageConfigSchema.safeParse({ prefix: 'a//b' });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.issues).toEqual([{ code: 'custom', message: 'Prefix must not contain empty, ".", or ".." segments', path: ['prefix'] }]);
  });

  it('rejects a prefix containing a "." segment', () => {
    expect(GcsStorageConfigSchema.safeParse({ prefix: 'a/./b' }).success).toBe(false);
  });

  it('rejects a prefix containing a ".." segment', () => {
    expect(GcsStorageConfigSchema.safeParse({ prefix: 'a/../b' }).success).toBe(false);
  });

  it('accepts a prefix with leading/trailing slashes (normalized at build time, not rejected at parse time)', () => {
    expect(GcsStorageConfigSchema.safeParse({ prefix: '/prod/wiki/' }).success).toBe(true);
  });

  it('.strict() rejects an unknown field', () => {
    expect(GcsStorageConfigSchema.safeParse({ bucket: 'b', unknownField: 'x' }).success).toBe(false);
  });
});

describe('parseServiceAccountKey', () => {
  it('returns mode "adc" for empty/whitespace-only input', () => {
    expect(parseServiceAccountKey('')).toEqual({ mode: 'adc' });
    expect(parseServiceAccountKey('   ')).toEqual({ mode: 'adc' });
  });

  it('returns mode "inline" with parsed credentials for a valid key', () => {
    expect(parseServiceAccountKey(validKeyJson())).toEqual({
      mode: 'inline',
      credentials: { project_id: 'key-project', client_email: 'sa@key-project.iam.gserviceaccount.com', private_key: VALID_PEM },
    });
  });

  it('returns mode "invalid" with the issue list for a malformed key', () => {
    const result = parseServiceAccountKey('not json');
    expect(result).toEqual({ mode: 'invalid', issues: ['Must be valid JSON object'] });
  });
});

describe('normalizePrefix / objectName (AC-3)', () => {
  it('strips leading and trailing slashes only', () => {
    expect(normalizePrefix('prod/wiki/')).toBe('prod/wiki');
    expect(normalizePrefix('/prod/wiki')).toBe('prod/wiki');
    expect(normalizePrefix('prod/wiki')).toBe('prod/wiki');
    expect(normalizePrefix('')).toBe('');
  });

  it('matches the spec worked example: prefix "prod/wiki/" + key "attachment/p/k.png" -> "prod/wiki/attachment/p/k.png"', () => {
    const prefix = normalizePrefix('prod/wiki/');
    expect(objectName(prefix, 'attachment/p/k.png')).toBe('prod/wiki/attachment/p/k.png');
  });

  it('returns the key unchanged when the prefix is empty', () => {
    expect(objectName('', 'attachment/p/k.png')).toBe('attachment/p/k.png');
  });

  it('does not trim, URL-encode, or path-normalize the key itself', () => {
    expect(objectName('', '  weird key/../x  ')).toBe('  weird key/../x  ');
  });

  it('accepts a physical name of exactly 1 UTF-8 byte (the lower boundary)', () => {
    expect(objectName('', 'a')).toBe('a');
  });

  it('accepts a physical name of exactly 1023 UTF-8 bytes (one below the upper boundary)', () => {
    const key = 'a'.repeat(1023);
    expect(objectName('', key)).toBe(key);
  });

  it('accepts a physical name of exactly 1024 UTF-8 bytes', () => {
    const key = 'a'.repeat(1024);
    expect(objectName('', key)).toBe(key);
  });

  it('rejects a physical name of 1025 UTF-8 bytes', () => {
    const key = 'a'.repeat(1025);
    expect(() => objectName('', key)).toThrow('GCS object name must be between 1 and 1024 UTF-8 bytes');
  });

  it('rejects an empty physical name (empty prefix + empty key)', () => {
    expect(() => objectName('', '')).toThrow('GCS object name must be between 1 and 1024 UTF-8 bytes');
  });

  it('counts multi-byte UTF-8 characters by their byte length, not code-point count', () => {
    // U+3042 ("あ") is 3 bytes in UTF-8; 342 chars = 1026 bytes > 1024.
    const key = 'あ'.repeat(342);
    expect(() => objectName('', key)).toThrow('GCS object name must be between 1 and 1024 UTF-8 bytes');
  });

  it('accepts a multi-byte UTF-8 physical name landing exactly on the 1024-byte upper boundary', () => {
    // U+3042 ("あ") is 3 bytes in UTF-8; 341 chars = 1023 bytes, plus one
    // 1-byte ASCII char = 1024 bytes exactly — the valid multibyte
    // counterpart to the all-ASCII 1024-byte case above.
    const key = `${'あ'.repeat(341)}a`;
    expect(Buffer.byteLength(key, 'utf8')).toBe(1024);
    expect(objectName('', key)).toBe(key);
  });
});

describe('registerStorage — ADC/inline client construction, valid-config-only activation (AC-1, AC-2)', () => {
  it('constructs Storage with no credentials/projectId when serviceAccountKey is empty and projectId is empty (pure ADC)', () => {
    register(makeCtx({ bucket: 'b', prefix: '', projectId: '', serviceAccountKey: '' }));
    expect(constructedStorageOptions).toEqual([{}]);
  });

  it('constructs Storage with only projectId when serviceAccountKey is empty but projectId is set', () => {
    register(makeCtx({ bucket: 'b', prefix: '', projectId: 'explicit-project', serviceAccountKey: '' }));
    expect(constructedStorageOptions).toEqual([{ projectId: 'explicit-project' }]);
  });

  it('constructs Storage with inline credentials from the key, using the key’s own project_id when projectId is unset', () => {
    register(makeCtx({ bucket: 'b', prefix: '', projectId: '', serviceAccountKey: validKeyJson() }));
    expect(constructedStorageOptions).toEqual([
      {
        projectId: 'key-project',
        credentials: { client_email: 'sa@key-project.iam.gserviceaccount.com', private_key: VALID_PEM },
      },
    ]);
  });

  it('prefers the explicit projectId field over the key’s project_id', () => {
    register(makeCtx({ bucket: 'b', prefix: '', projectId: 'explicit-project', serviceAccountKey: validKeyJson() }));
    expect(constructedStorageOptions).toEqual([
      {
        projectId: 'explicit-project',
        credentials: { client_email: 'sa@key-project.iam.gserviceaccount.com', private_key: VALID_PEM },
      },
    ]);
  });

  it('registers a driver even when bucket is empty (schema-defaulted, valid config)', () => {
    const driver = register(makeCtx({ bucket: '', prefix: '', projectId: '', serviceAccountKey: '' }));
    expect(driver).toBeDefined();
    // No Storage client is ever built for an unavailable (bucket-less) state.
    expect(constructedStorageOptions).toEqual([]);
  });

  it('registers exactly one driver, under the stable name "gcs"', () => {
    register(makeCtx({ bucket: 'b', prefix: '', projectId: '', serviceAccountKey: '' }));
    expect(registerCalls).toHaveLength(1);
    expect(registerCalls[0].name).toBe('gcs');
  });

  it('every operation on an unavailable (bucket-less) driver rejects with a configuration error and never touches the SDK', async () => {
    const driver = register(makeCtx({ bucket: '', prefix: '', projectId: '', serviceAccountKey: '' }));
    await expect(driver.put('k', Buffer.from('x'), { contentType: 'text/plain' })).rejects.toThrow(/bucket is not configured/);
    await expect(driver.get('k')).rejects.toThrow(/bucket is not configured/);
    await expect(driver.delete('k')).rejects.toThrow(/bucket is not configured/);
    await expect(driver.signedUrl?.('k', 300)).rejects.toThrow(/bucket is not configured/);
    expect(constructedStorageOptions).toEqual([]);
  });

  it('reconfigure rebuilds Storage with the new credential mode; subsequent calls use the new bucket', async () => {
    const driver = register(makeCtx({ bucket: 'old', prefix: '', projectId: '', serviceAccountKey: '' }));
    await gcsPlugin.reconfigure?.(makeCtx({ bucket: 'new', prefix: '', projectId: '', serviceAccountKey: validKeyJson() }));

    await driver.put('k', Buffer.from('x'), { contentType: 'text/plain' });
    const newBucket = constructedBuckets.at(-1);
    expect(newBucket?.name).toBe('new');
    expect(constructedStorageOptions.at(-1)).toMatchObject({ credentials: expect.any(Object) });
  });
});

describe('createGcsDriver — same physical name across all four operations, invalid names rejected pre-request (AC-3)', () => {
  it('put/get/delete/signedUrl all call bucket.file() with the identical prefixed physical name', async () => {
    const { driver, bucket } = registerWithPrefix('prod/wiki/');

    await driver.put('attachment/p/k.png', Buffer.from('x'), { contentType: 'image/png' });
    const getPromise = driver.get('attachment/p/k.png');
    completeSuccessfulRead(bucket, Buffer.from('x'));
    await getPromise;
    await driver.delete('attachment/p/k.png');
    await driver.signedUrl?.('attachment/p/k.png', 300);

    expect(bucket.file).toHaveBeenCalledTimes(4);
    for (const call of bucket.file.mock.calls) {
      expect(call[0]).toBe('prod/wiki/attachment/p/k.png');
    }
  });

  it('put returns the logical key unchanged (not the physical name)', async () => {
    const { driver } = registerWithPrefix('prod/wiki');
    const result = await driver.put('attachment/p/k.png', Buffer.from('x'), { contentType: 'image/png' });
    expect(result).toEqual({ key: 'attachment/p/k.png' });
  });

  it('uses the key unchanged as the physical name when prefix is empty', async () => {
    const { driver, bucket } = registerWithPrefix('');
    const getPromise = driver.get('attachment/p/k.png');
    completeSuccessfulRead(bucket, Buffer.from('x'));
    await getPromise;
    expect(bucket.file).toHaveBeenCalledWith('attachment/p/k.png');
  });

  it('rejects an oversized physical name before calling bucket.file() (put/get/delete/signedUrl)', async () => {
    const { driver, bucket } = registerWithPrefix('');
    const oversizedKey = 'a'.repeat(1025);

    await expect(driver.put(oversizedKey, Buffer.from('x'), { contentType: 'text/plain' })).rejects.toThrow(/1024 UTF-8 bytes/);
    await expect(driver.get(oversizedKey)).rejects.toThrow(/1024 UTF-8 bytes/);
    await expect(driver.delete(oversizedKey)).rejects.toThrow(/1024 UTF-8 bytes/);
    await expect(driver.signedUrl?.(oversizedKey, 300)).rejects.toThrow(/1024 UTF-8 bytes/);
    expect(bucket.file).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range signedUrl TTL before calling bucket.file()', async () => {
    const { driver, bucket } = registerWithPrefix('');
    await expect(driver.signedUrl?.('k', 0)).rejects.toThrow(/Signed URL expiry must be an integer between 1 and 604800 seconds/);
    await expect(driver.signedUrl?.('k', 604801)).rejects.toThrow(/Signed URL expiry must be an integer between 1 and 604800 seconds/);
    await expect(driver.signedUrl?.('k', 1.5)).rejects.toThrow(/Signed URL expiry must be an integer between 1 and 604800 seconds/);
    expect(bucket.file).not.toHaveBeenCalled();
  });

  it('accepts signedUrl TTL boundaries of 1 and 604800 seconds', async () => {
    const { driver, bucket } = registerWithPrefix('');
    await expect(driver.signedUrl?.('k', 1)).resolves.toBe('https://signed.example/fake');
    await expect(driver.signedUrl?.('k', 604800)).resolves.toBe('https://signed.example/fake');
    expect(bucket.file).toHaveBeenCalledTimes(2);
  });
});

/**
 * `makeCtx().config()` now runs the fixture through the real
 * `GcsStorageConfigSchema` exactly like `createPluginContext.config()` does
 * (see the comment on `makeCtx` above) — so calling `register()` here
 * exercises the SAME path real `PluginManager.activate()` takes: `ctx.config()`
 * throws, `registerStorage` never runs, `registry.register` is never called,
 * and no `Storage` client is ever constructed. This is the missing lifecycle
 * proof the plain `GcsStorageConfigSchema.safeParse(...)` assertion (the
 * previous version of this suite) did not provide — a schema rejection alone
 * doesn't show that activation itself is aborted before any provider call.
 */
describe('activation failure for invalid stored config (AC-1, AC-3)', () => {
  it('a malformed stored serviceAccountKey aborts activation before registry.register or any Storage construction', () => {
    expect(() => register(makeCtx({ bucket: 'b', serviceAccountKey: 'not json' }))).toThrow(/config validation failed/);
    expect(registerCalls).toHaveLength(0);
    expect(constructedStorageOptions).toEqual([]);
  });

  it('an unknown stored flat field (schema is .strict()) aborts activation the same way', () => {
    expect(() => register(makeCtx({ bucket: 'b', unknownField: 'x' }))).toThrow(/config validation failed/);
    expect(registerCalls).toHaveLength(0);
    expect(constructedStorageOptions).toEqual([]);
  });

  it('an invalid stored prefix aborts activation before registry.register or any Storage construction', () => {
    expect(() => register(makeCtx({ bucket: 'b', prefix: 'a//b' }))).toThrow(/config validation failed/);
    expect(registerCalls).toHaveLength(0);
    expect(constructedStorageOptions).toEqual([]);
  });
});

describe('createGcsDriver#delete — the full AC-7 matrix (existing/absent/failure)', () => {
  it('passes ignoreNotFound: true and resolves when the object exists', async () => {
    const { driver, bucket } = registerWithPrefix('');
    const file = bucket.file('attachment/p/k.png');
    file.delete.mockResolvedValueOnce(undefined);
    await expect(driver.delete('attachment/p/k.png')).resolves.toBeUndefined();
    expect(file.delete).toHaveBeenCalledWith({ ignoreNotFound: true });
  });

  it('resolves (no-op, does not reject) when the object is absent — ignoreNotFound absorbs the SDK 404', async () => {
    const { driver, bucket } = registerWithPrefix('');
    const file = bucket.file('attachment/p/k.png');
    // Mirrors the real SDK: without `ignoreNotFound` a missing object
    // rejects with a 404 `ApiError`; WITH it, the SDK swallows that 404 and
    // resolves instead. Driving the mock through that exact branch proves
    // the driver's no-op behavior end to end, not just that it passed the
    // option (`StorageDriver.delete`'s idempotent contract).
    file.delete.mockImplementationOnce(async (options?: { ignoreNotFound?: boolean }) => {
      if (!options?.ignoreNotFound) throw Object.assign(new Error('Not Found'), { code: 404, name: 'ApiError' });
    });
    await expect(driver.delete('attachment/p/k.png')).resolves.toBeUndefined();
  });

  it('propagates permission/credential/network failures to the caller — ignoreNotFound only absorbs 404s', async () => {
    const { driver, bucket } = registerWithPrefix('');
    const file = bucket.file('attachment/p/k.png');
    const permissionError = Object.assign(new Error('Forbidden'), { code: 403, name: 'ApiError' });
    file.delete.mockRejectedValueOnce(permissionError);
    await expect(driver.delete('attachment/p/k.png')).rejects.toBe(permissionError);
  });
});

/**
 * AC-5 (streaming handshake) + AC-6 (404->ENOENT missing-object conversion,
 * pinned against the REAL, unmodified core classifier). Drives the fake
 * `createReadStream()` stream through the exact `response`/`data`/`end`/
 * `error` sequence SDK 7.21.0 uses (verified against
 * `File#createReadStream`'s `onResponse`/`util.handleResp` in
 * `node_modules/@google-cloud/storage`), so a change to that handshake
 * logic that violates the spec's ordering/timeout/buffering rules fails
 * here instead of only showing up against real GCS.
 */
describe('createGcsDriver#get — streaming handshake and 404 classification (AC-5, AC-6)', () => {
  it('attaches error/response/data/end listeners and starts the request (resume()) before any bytes can arrive', () => {
    const { driver, bucket } = registerWithPrefix('');
    void driver.get('k'); // fire-and-forget: only the synchronous setup is under test here
    const stream = lastCreatedReadStream(bucket);
    expect(stream.listenerCount('error')).toBe(1);
    expect(stream.listenerCount('response')).toBe(1);
    expect(stream.listenerCount('data')).toBe(1);
    expect(stream.listenerCount('end')).toBe(1);
    expect(stream.readableFlowing).toBe(true); // resume() was called
    stream.emit('response', { statusCode: 200 });
    stream.push(null);
  });

  it('resolves once the first chunk arrives after a 2xx response, relaying it losslessly with the rest of the stream', async () => {
    const { driver, bucket } = registerWithPrefix('');
    const getPromise = driver.get('k');
    const stream = lastCreatedReadStream(bucket);
    stream.emit('response', { statusCode: 200 });
    stream.push(Buffer.from('hello '));
    stream.push(Buffer.from('world'));
    stream.push(null);

    const relay = await getPromise;
    const chunks: Buffer[] = [];
    for await (const chunk of relay) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString('utf8')).toBe('hello world');
  });

  it('resolves with an empty stream on EOF with no data (0-byte object)', async () => {
    const { driver, bucket } = registerWithPrefix('');
    const getPromise = driver.get('k');
    const stream = lastCreatedReadStream(bucket);
    stream.emit('response', { statusCode: 200 });
    stream.push(null);

    const relay = await getPromise;
    const chunks: Buffer[] = [];
    for await (const chunk of relay) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toHaveLength(0);
  });

  it('holds and relays exactly one chunk that arrives before the response event, without losing it', async () => {
    const { driver, bucket } = registerWithPrefix('');
    const getPromise = driver.get('k');
    const stream = lastCreatedReadStream(bucket);

    stream.push(Buffer.from('early-chunk'));
    // Let the (possibly next-tick-deferred) `data` event land — and get
    // held by `onData`'s `source.pause()` branch — before `response` fires,
    // deterministically exercising the "data arrived first" path rather
    // than leaving the ordering to chance.
    await new Promise((resolve) => setImmediate(resolve));
    stream.emit('response', { statusCode: 200 });
    stream.push(null);

    const relay = await getPromise;
    const chunks: Buffer[] = [];
    for await (const chunk of relay) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString('utf8')).toBe('early-chunk');
  });

  it('never resolves or rejects on a non-2xx response alone — waits for the SDK to actually emit its error', async () => {
    const { driver, bucket } = registerWithPrefix('');
    const getPromise = driver.get('k');
    const stream = lastCreatedReadStream(bucket);

    stream.emit('response', { statusCode: 404 });
    // Give any (incorrect) synchronous-or-microtask resolution a chance to
    // fire before asserting the promise is still pending.
    const settledFirst: Promise<'resolved' | 'rejected'> = getPromise.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    );
    const stillPending = new Promise<'still-pending'>((resolve) => setImmediate(() => resolve('still-pending')));
    await expect(Promise.race([settledFirst, stillPending])).resolves.toBe('still-pending');

    const apiError = Object.assign(new Error('Not Found'), { code: 404, name: 'ApiError' });
    stream.destroy(apiError);
    await expect(getPromise).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not resolve as an empty success when EOF follows a non-2xx response with no error yet — stays pending until the SDK error (or timeout) follows', async () => {
    const { driver, bucket } = registerWithPrefix('');
    const getPromise = driver.get('k');
    const stream = lastCreatedReadStream(bucket);

    stream.emit('response', { statusCode: 404 });
    // Emitted directly (not via `push(null)`) to isolate `onEnd`'s handling
    // of the 'end' event itself: `push(null)` drives Node's OWN internal EOF
    // machinery, which auto-destroys the stream right after 'end' — so a
    // later `.destroy(err)` would be a no-op and never emit 'error',
    // confounding this test with a Node stream-lifecycle detail unrelated to
    // what's under test here (verified empirically: `readableEnded`/
    // `destroyed` are already `true` by the time `push(null)`'s 'end'
    // handler returns).
    stream.emit('end'); // EOF with no `error` yet — must NOT resolve as an empty successful download.

    const settledFirst: Promise<'resolved' | 'rejected'> = getPromise.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    );
    const stillPending = new Promise<'still-pending'>((resolve) => setImmediate(() => resolve('still-pending')));
    await expect(Promise.race([settledFirst, stillPending])).resolves.toBe('still-pending');

    const apiError = Object.assign(new Error('Not Found'), { code: 404, name: 'ApiError' });
    stream.destroy(apiError);
    await expect(getPromise).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('converts a 404 into an Error with code "ENOENT" and the provider ApiError as cause, and the REAL isMissingFileError classifies it as missing', async () => {
    const { driver, bucket } = registerWithPrefix('');
    const getPromise = driver.get('missing-key');
    const stream = lastCreatedReadStream(bucket);
    stream.emit('response', { statusCode: 404 });
    const apiError = Object.assign(new Error('Not Found'), { code: 404, name: 'ApiError' });
    stream.destroy(apiError);

    let caught: unknown;
    try {
      await getPromise;
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: 'ENOENT', cause: apiError });
    // The message IS the logical key — nothing else (spec §5: "message は
    // logical key だけを含め").
    expect((caught as Error).message).toBe('missing-key');
    expect(isMissingFileError(caught)).toBe(true);
  });

  it('does not convert a 403 — it propagates unchanged and the real isMissingFileError returns false', async () => {
    const { driver, bucket } = registerWithPrefix('');
    const getPromise = driver.get('k');
    const stream = lastCreatedReadStream(bucket);
    stream.emit('response', { statusCode: 403 });
    const apiError = Object.assign(new Error('Forbidden'), { code: 403, name: 'ApiError' });
    stream.destroy(apiError);

    await expect(getPromise).rejects.toBe(apiError);
    expect(isMissingFileError(apiError)).toBe(false);
  });

  it('does not convert a codeless network error — it propagates unchanged and the real isMissingFileError returns false', async () => {
    const { driver, bucket } = registerWithPrefix('');
    const getPromise = driver.get('k');
    const stream = lastCreatedReadStream(bucket);
    const networkError = new Error('socket hang up');
    stream.destroy(networkError);

    await expect(getPromise).rejects.toBe(networkError);
    expect(isMissingFileError(networkError)).toBe(false);
  });

  it('forwards a post-handshake (mid-stream) error to the relay as a downstream error, unconverted', async () => {
    const { driver, bucket } = registerWithPrefix('');
    const getPromise = driver.get('k');
    const stream = lastCreatedReadStream(bucket);
    stream.emit('response', { statusCode: 200 });
    stream.push(Buffer.from('partial'));

    const relay = await getPromise;
    const relayError = new Promise((resolve) => relay.once('error', resolve));
    const midStreamError = new Error('connection reset mid-download');
    stream.destroy(midStreamError);

    await expect(relayError).resolves.toBe(midStreamError);
  });

  it('destroys the source and rejects with a timeout error if nothing terminates within 10s', async () => {
    jest.useFakeTimers();
    try {
      const { driver, bucket } = registerWithPrefix('');
      const getPromise = driver.get('k');
      const stream = lastCreatedReadStream(bucket);
      const destroySpy = jest.spyOn(stream, 'destroy');

      // Attach the rejection assertion BEFORE advancing the fake timer: the
      // timeout callback rejects synchronously once the timer fires, so
      // constructing the `.rejects` assertion first (rather than after
      // `advanceTimersByTimeAsync`) is what actually attaches a handler in
      // time to observe it, instead of racing an unhandled rejection.
      const rejection = expect(getPromise).rejects.toThrow(/timed out/);
      await jest.advanceTimersByTimeAsync(10_000);
      await rejection;
      expect(destroySpy).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

// Compile-time only: proves `GcsState`/`createGcsDriver` stay exported with
// the shape the spec's implementation map names.
function _typeSmoke(state: GcsState): StorageDriver {
  return createGcsDriver({ get: () => state, withValue: async (fn) => fn(state), set: () => undefined });
}
void _typeSmoke;
