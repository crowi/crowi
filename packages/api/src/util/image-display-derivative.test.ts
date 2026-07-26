import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { StateCell, StorageDriver } from '@crowi/plugin-api';
import { createS3Driver } from '@crowi/plugin-storage-aws-s3';
import { createLocalDriver } from '@crowi/plugin-storage-local';
import { Types } from 'mongoose';
import sharp from 'sharp';

import { crowi } from 'src/test/setup';
import { createPageViaApi, createTestUser } from 'src/test/test-helpers';
import {
  ADMISSION_QUEUE_LIMIT,
  buildDisplayDerivativeKey,
  DISPLAY_DERIVATIVE_MIME_TYPES,
  DISPLAY_DERIVATIVE_RECIPE_VERSION,
  displayDerivativeKeyCandidates,
  type GenerateAndPublishResult,
  generateAndPublishDisplayDerivative,
  generateDisplayDerivativeBuffer,
  generateDisplayDerivativeForUpload,
  resolveAdmissionConcurrency,
  resolveAdmissionTimeoutMs,
  resolveMaxInputPixels,
  TARGET_MAX_WIDTH,
} from 'src/util/image-display-derivative';
import { Semaphore } from 'src/util/semaphore';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crowi-image-derivative-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

let fixtureCounter = 0;
async function writeFixture(buf: Buffer, ext: string): Promise<string> {
  fixtureCounter += 1;
  const p = path.join(tmpDir, `fixture-${fixtureCounter}.${ext}`);
  await fs.writeFile(p, buf);
  return p;
}

async function rasterBuffer(width: number, height: number, format: 'jpeg' | 'png' | 'webp', orientation?: number): Promise<Buffer> {
  let pipeline = sharp({
    create: { width, height, channels: 3, background: { r: 90, g: 130, b: 170 } },
  });
  if (orientation !== undefined) {
    pipeline = pipeline.withMetadata({ orientation });
  }
  switch (format) {
    case 'jpeg':
      return pipeline.jpeg().toBuffer();
    case 'png':
      return pipeline.png().toBuffer();
    case 'webp':
      return pipeline.webp().toBuffer();
  }
}

/** A 4-color-banded PNG saved with an indexed palette — deliberately tiny (a few hundred bytes) so a full-color re-encode of the resized image is larger (drives the `no-size-benefit` branch deterministically). */
async function paletteBandedPngBuffer(width: number, height: number): Promise<Buffer> {
  const channels = 3;
  const buf = Buffer.alloc(width * height * channels);
  const colours = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0],
  ];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const band = Math.floor(x / (width / colours.length)) % colours.length;
      const idx = (y * width + x) * channels;
      buf[idx] = colours[band][0];
      buf[idx + 1] = colours[band][1];
      buf[idx + 2] = colours[band][2];
    }
  }
  return sharp(buf, { raw: { width, height, channels } }).png({ palette: true, colours: 4, compressionLevel: 9 }).toBuffer();
}

async function animatedWebpBuffer(width: number, height: number, frames: number): Promise<Buffer> {
  const pngFrames = await Promise.all(
    Array.from({ length: frames }, (_, i) =>
      sharp({ create: { width, height, channels: 3, background: { r: i * 40, g: 0, b: 0 } } })
        .png()
        .toBuffer(),
    ),
  );
  return sharp(pngFrames, { join: { animated: true } })
    .webp()
    .toBuffer();
}

/** Build one PNG chunk (4-byte length + 4-byte ASCII type + data + 4-byte CRC32). Shared by every hand-built PNG fixture in this file. */
async function pngChunk(type: string, data: Buffer): Promise<Buffer> {
  const zlib = await import('node:zlib');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * Hand-build a minimal, spec-conformant 2-frame APNG (signature + IHDR +
 * [optional padding ancillary chunk] + acTL + fcTL + IDAT (frame 1) + fcTL +
 * fdAT (frame 2) + IEND). Verified against this repo's sharp/libvips build
 * to correctly parse as `format: 'png'` with the right width/height — see
 * `pngHasAnimationChunk`'s doc comment in `image-display-derivative.ts` for
 * why `metadata().pages` itself cannot detect this and a chunk-boundary
 * scan is used instead.
 *
 * `paddingBytesBeforeActl`, when > 0, inserts an unknown-but-well-formed
 * ANCILLARY chunk (type `paDA` — lowercase first letter per the PNG naming
 * convention so any conformant decoder skips it unread rather than
 * erroring; the THIRD letter must stay uppercase — that's the reserved bit,
 * and a decoder is entitled to reject the whole file as non-conformant if
 * it's lowercase, which is exactly what sharp 0.35's libpng-backed PNG
 * loader started doing once this fixture briefly used `padA` here) between
 * `IHDR` and `acTL`, pushing the real `acTL` chunk's byte offset past that
 * padding. Used to prove the detector walks chunk boundaries (correct at
 * any offset) rather than relying on a fixed-size raw byte-window scan
 * (which would miss an `acTL` sitting past the window — the exact bug this
 * fixture regression-tests).
 */
async function minimalApngBuffer(width: number, height: number, paddingBytesBeforeActl = 0): Promise<Buffer> {
  const zlib = await import('node:zlib');

  const rawFrame = (r: number, g: number, b: number): Buffer => {
    const rowBytes = 1 + width * 3;
    const buf = Buffer.alloc(rowBytes * height);
    for (let y = 0; y < height; y += 1) {
      const rowStart = y * rowBytes;
      buf[rowStart] = 0;
      for (let x = 0; x < width; x += 1) {
        const px = rowStart + 1 + x * 3;
        buf[px] = r;
        buf[px + 1] = g;
        buf[px + 2] = b;
      }
    }
    return zlib.deflateSync(buf);
  };

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 2;
  const ihdr = await pngChunk('IHDR', ihdrData);

  const padding = paddingBytesBeforeActl > 0 ? await pngChunk('paDA', Buffer.alloc(paddingBytesBeforeActl, 0x20)) : Buffer.alloc(0);

  const actlData = Buffer.alloc(8);
  actlData.writeUInt32BE(2, 0);
  actlData.writeUInt32BE(0, 4);
  const actl = await pngChunk('acTL', actlData);

  let seq = 0;
  const fctlChunk = async (): Promise<Buffer> => {
    const d = Buffer.alloc(26);
    d.writeUInt32BE(seq, 0);
    seq += 1;
    d.writeUInt32BE(width, 4);
    d.writeUInt32BE(height, 8);
    d.writeUInt16BE(100, 20);
    d.writeUInt16BE(100, 22);
    return pngChunk('fcTL', d);
  };

  const fctl1 = await fctlChunk();
  const idat = await pngChunk('IDAT', rawFrame(255, 0, 0));
  const fctl2 = await fctlChunk();
  const frame2 = rawFrame(0, 255, 0);
  const fdatData = Buffer.alloc(4 + frame2.length);
  fdatData.writeUInt32BE(seq, 0);
  seq += 1;
  frame2.copy(fdatData, 4);
  const fdat = await pngChunk('fdAT', fdatData);
  const iend = await pngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, padding, actl, fctl1, idat, fctl2, fdat, iend]);
}

/**
 * Insert an unknown-but-well-formed ANCILLARY chunk (type `quXx` — lowercase
 * first letter, so any conformant decoder skips it unread) immediately
 * after a real PNG's `IHDR` chunk, with `data` as its payload. Used to prove
 * `pngHasAnimationChunk` never false-positives on the literal bytes
 * `'acTL'`/`'IDAT'` appearing inside an unrelated chunk's DATA — it only
 * ever inspects chunk TYPE bytes at their real offsets.
 */
async function injectDecoyAncillaryChunkAfterIHDR(png: Buffer, data: Buffer): Promise<Buffer> {
  const ihdrDataLength = png.readUInt32BE(8);
  const ihdrEnd = 8 /* signature */ + 8 /* IHDR length+type */ + ihdrDataLength + 4 /* IHDR crc */;
  const decoy = await pngChunk('quXx', data);
  return Buffer.concat([png.subarray(0, ihdrEnd), decoy, png.subarray(ihdrEnd)]);
}

// ---------------------------------------------------------------------------
// Fake S3 driver — real `@aws-sdk/client-s3` Command classes (plain input
// holders, safe to construct without network access) routed to an
// in-memory bucket instead of a real client. This exercises the actual
// `createS3Driver` implementation (`@crowi/plugin-storage-aws-s3`), just
// with its `client.send()` faked, so "local・S3両ドライバに対する結合テスト"
// (spec AC) run the SAME assertions against the real S3 driver code path
// without needing network access or `jest.mock` module hoisting.
// ---------------------------------------------------------------------------

async function toBuffer(input: Buffer | Readable): Promise<Buffer> {
  if (Buffer.isBuffer(input)) return input;
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function makeFakeS3Driver(): StorageDriver {
  const bucket = new Map<string, Buffer>();

  const fakeClient = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof PutObjectCommand) {
        const { Key, Body } = command.input;
        bucket.set(Key as string, await toBuffer(Body as Buffer | Readable));
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const { Key } = command.input;
        const data = bucket.get(Key as string);
        if (!data) {
          // Real AWS SDK v3 missing-object shape: `name: 'NoSuchKey'`, no `code`.
          throw Object.assign(new Error('The specified key does not exist.'), {
            name: 'NoSuchKey',
            $metadata: { httpStatusCode: 404 },
          });
        }
        return { Body: Readable.from(data) };
      }
      if (command instanceof DeleteObjectCommand) {
        bucket.delete(command.input.Key as string);
        return {};
      }
      throw new Error(`makeFakeS3Driver: unexpected command ${String((command as { constructor: { name: string } }).constructor.name)}`);
    },
    // Unused by createS3Driver's put/get/delete/signedUrl but part of the
    // real S3Client's surface — never invoked in these tests.
    destroy: () => {},
  };

  const cell: StateCell<{ client: S3Client; bucket: string }> = {
    get: () => ({ client: fakeClient as unknown as S3Client, bucket: 'fake-bucket' }),
    withValue: async (fn) => fn({ client: fakeClient as unknown as S3Client, bucket: 'fake-bucket' }),
    set: () => {
      throw new Error('makeFakeS3Driver: set() is not supported — this fake never reconfigures');
    },
  };

  return createS3Driver(cell);
}

type DriverKind = 'local' | 's3';

/**
 * Temporarily makes `kind`'s driver the process-wide active storage driver
 * (mirrors `storage-copy.test.ts`'s direct-registry-mutation approach) for
 * the duration of `fn`, then restores whatever was active before —
 * `Attachment`'s cached `fileUploader` re-resolves the active driver on
 * every call, so this swap is picked up immediately.
 */
async function withDriver<T>(kind: DriverKind, fn: (driver: StorageDriver) => Promise<T>): Promise<T> {
  const registries = crowi.getPlugins();
  const original = registries.active.storage;
  let localRoot: string | null = null;
  const driver =
    kind === 'local'
      ? createLocalDriver({ rootDir: (localRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'crowi-image-derivative-s3-parity-'))) })
      : makeFakeS3Driver();
  registries.active.storage = driver;
  try {
    return await fn(driver);
  } finally {
    registries.active.storage = original;
    if (localRoot) await fs.rm(localRoot, { recursive: true, force: true });
  }
}

/**
 * Asserts `promise` rejects with the DRIVER-SPECIFIC missing-object error
 * shape (AC12), not just "any" rejection — a generic `rejects.toBeDefined()`
 * would equally pass for a timeout, a permission error, or a corrupted read,
 * none of which prove the object is actually gone/never-written. Mirrors the
 * real shapes each driver produces: the local driver's `fs` calls reject
 * with Node's `ENOENT` `code` (see `plugin-storage-local`'s `get`/`delete`),
 * while `@aws-sdk/client-s3`'s `GetObjectCommand`/`DeleteObjectCommand`
 * reject with `name: 'NoSuchKey'` (see `makeFakeS3Driver` above, which
 * mirrors the real SDK's error shape) and no `code` field at all.
 */
async function expectMissingObject(kind: DriverKind, promise: Promise<unknown>): Promise<void> {
  if (kind === 'local') {
    await expect(promise).rejects.toMatchObject({ code: 'ENOENT' });
  } else {
    await expect(promise).rejects.toMatchObject({ name: 'NoSuchKey' });
  }
}

// ---------------------------------------------------------------------------
// generateDisplayDerivativeBuffer — pure classification + encode
// ---------------------------------------------------------------------------

describe('generateDisplayDerivativeBuffer', () => {
  it('classifies a small JPEG (<=1728px) as passthrough/within-target-width and does not encode', async () => {
    const src = await writeFixture(await rasterBuffer(200, 100, 'jpeg'), 'jpg');
    const result = await generateDisplayDerivativeBuffer(src);
    expect(result).toEqual({ mode: 'passthrough', reason: 'within-target-width' });
  });

  it('resizes a large JPEG to exactly TARGET_MAX_WIDTH and derives the MIME (not decoder id) format', async () => {
    const src = await writeFixture(await rasterBuffer(2000, 1000, 'jpeg'), 'jpg');
    const result = await generateDisplayDerivativeBuffer(src);
    expect(result.mode).toBe('resized');
    if (result.mode !== 'resized') throw new Error('unreachable');
    expect(result.width).toBe(TARGET_MAX_WIDTH);
    expect(result.height).toBe(864); // 2000x1000 source (2:1) -> 1728x864
    expect(result.ext).toBe('jpg');
    // AC: format must be a MIME string ('image/jpeg'), never sharp's
    // decoder identifier ('jpeg').
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.mimeType).not.toBe('jpeg');
    expect(Buffer.isBuffer(result.data)).toBe(true);
    expect(result.size).toBe(result.data.length);
  });

  it('resizes a large static PNG and reports image/png (with alpha preserved by not forcing a palette)', async () => {
    const src = await writeFixture(await rasterBuffer(2000, 1200, 'png'), 'png');
    const result = await generateDisplayDerivativeBuffer(src);
    expect(result.mode).toBe('resized');
    if (result.mode !== 'resized') throw new Error('unreachable');
    expect(result.ext).toBe('png');
    expect(result.mimeType).toBe('image/png');
    expect(result.width).toBe(TARGET_MAX_WIDTH);
  });

  it('resizes a large static WebP and reports image/webp', async () => {
    const src = await writeFixture(await rasterBuffer(2000, 900, 'webp'), 'webp');
    const result = await generateDisplayDerivativeBuffer(src);
    expect(result.mode).toBe('resized');
    if (result.mode !== 'resized') throw new Error('unreachable');
    expect(result.ext).toBe('webp');
    expect(result.mimeType).toBe('image/webp');
  });

  it('applies Exif orientation before measuring width: a wide raw image tagged portrait-rotated passes through', async () => {
    // Raw 2000x1000 tagged orientation=6 (90° CW) -> physically 1000x2000, well under the 1728px target.
    const src = await writeFixture(await rasterBuffer(2000, 1000, 'jpeg', 6), 'jpg');
    const result = await generateDisplayDerivativeBuffer(src);
    expect(result).toEqual({ mode: 'passthrough', reason: 'within-target-width' });
  });

  it('applies Exif orientation before measuring width: a narrow raw image tagged landscape-rotated gets resized', async () => {
    // Raw 1000x2000 tagged orientation=6 (90° CW) -> physically 2000x1000, over the 1728px target.
    const src = await writeFixture(await rasterBuffer(1000, 2000, 'jpeg', 6), 'jpg');
    const result = await generateDisplayDerivativeBuffer(src);
    expect(result.mode).toBe('resized');
    if (result.mode !== 'resized') throw new Error('unreachable');
    expect(result.width).toBe(TARGET_MAX_WIDTH);
    expect(result.height).toBe(864);
  });

  it('strips metadata from the re-encoded output (no orientation tag / exif survives)', async () => {
    // Raw 1000x2000 tagged orientation=6 -> physically 2000x1000, over the
    // 1728px target, so this actually goes through the resize/re-encode
    // branch (unlike the 2000x1000-tagged-6 fixture above, which passes
    // through untouched at its oriented 1000px width).
    const src = await writeFixture(await rasterBuffer(1000, 2000, 'jpeg', 6), 'jpg');
    const result = await generateDisplayDerivativeBuffer(src);
    if (result.mode !== 'resized') throw new Error('unreachable');
    const outMeta = await sharp(result.data).metadata();
    expect(outMeta.orientation).toBeUndefined();
    expect(outMeta.exif).toBeUndefined();
  });

  it('discards a resize that would not shrink the file and records no-size-benefit', async () => {
    // A tiny palette-indexed PNG "original" vs. a full-color re-encode of
    // the resized image — the re-encode is larger despite fewer pixels.
    const src = await writeFixture(await paletteBandedPngBuffer(2000, 40), 'png');
    const result = await generateDisplayDerivativeBuffer(src);
    expect(result).toEqual({ mode: 'passthrough', reason: 'no-size-benefit' });
  });

  it('classifies SVG as unsupported/svg without rasterizing', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1000"><rect width="2000" height="1000" fill="red"/></svg>');
    const src = await writeFixture(svg, 'svg');
    const result = await generateDisplayDerivativeBuffer(src);
    expect(result).toEqual({ mode: 'unsupported', reason: 'svg' });
  });

  it('classifies GIF (static, single-frame) as unsupported/gif', async () => {
    const src = await writeFixture(
      await sharp({ create: { width: 2000, height: 900, channels: 3, background: { r: 1, g: 2, b: 3 } } })
        .gif()
        .toBuffer(),
      'gif',
    );
    const result = await generateDisplayDerivativeBuffer(src);
    expect(result).toEqual({ mode: 'unsupported', reason: 'gif' });
  });

  it('classifies animated WebP (multi-frame) as unsupported/animated', async () => {
    const src = await writeFixture(await animatedWebpBuffer(2000, 800, 2), 'webp');
    const result = await generateDisplayDerivativeBuffer(src);
    expect(result).toEqual({ mode: 'unsupported', reason: 'animated' });
  });

  it('classifies APNG (multi-frame PNG) as unsupported/animated via the acTL chunk scan', async () => {
    const src = await writeFixture(await minimalApngBuffer(2000, 40), 'png');
    const result = await generateDisplayDerivativeBuffer(src);
    expect(result).toEqual({ mode: 'unsupported', reason: 'animated' });
  });

  it('classifies APNG as unsupported/animated even when a >64KiB ancillary chunk pushes the real acTL chunk past a fixed 64KiB byte offset (chunk-boundary parsing, not a raw byte-window scan)', async () => {
    const src = await writeFixture(await minimalApngBuffer(2000, 40, 70_000), 'png');
    const result = await generateDisplayDerivativeBuffer(src);
    expect(result).toEqual({ mode: 'unsupported', reason: 'animated' });
  });

  it('classifies APNG as unsupported/animated even when a >8MiB ancillary chunk pushes the real acTL chunk past a fixed 8MiB byte offset (chunk scan is bounded by chunk COUNT, not cumulative offset — regression for the earlier offset-bounded scan limit)', async () => {
    const src = await writeFixture(await minimalApngBuffer(2000, 40, 9 * 1024 * 1024), 'png');
    const result = await generateDisplayDerivativeBuffer(src);
    expect(result).toEqual({ mode: 'unsupported', reason: 'animated' });
  }, 30_000);

  it('does NOT false-positive as animated on a static (single-IDAT) PNG whose ancillary chunk data happens to contain the literal ASCII bytes "acTL" and "IDAT"', async () => {
    const basePng = await rasterBuffer(2000, 1000, 'png');
    const decoyData = Buffer.from('this decoy chunk payload contains the literal text acTL and IDAT but is neither');
    const tampered = await injectDecoyAncillaryChunkAfterIHDR(basePng, decoyData);
    const src = await writeFixture(tampered, 'png');
    const result = await generateDisplayDerivativeBuffer(src);
    expect(result.mode).toBe('resized');
    if (result.mode !== 'resized') throw new Error('unreachable');
    expect(result.ext).toBe('png');
    expect(result.mimeType).toBe('image/png');
  });

  it('classifies a decodable-but-unsupported format (TIFF) as unsupported/unsupported-format', async () => {
    const src = await writeFixture(
      await sharp({ create: { width: 2000, height: 800, channels: 3, background: { r: 5, g: 5, b: 5 } } })
        .tiff()
        .toBuffer(),
      'tiff',
    );
    const result = await generateDisplayDerivativeBuffer(src);
    expect(result).toEqual({ mode: 'unsupported', reason: 'unsupported-format' });
  });

  it('classifies garbage bytes as failed/decode-error and does not crash', async () => {
    const src = await writeFixture(Buffer.from('this is not an image, just garbage bytes for testing purposes'), 'bin');
    const result = await generateDisplayDerivativeBuffer(src);
    expect(result).toEqual({ mode: 'failed', reason: 'decode-error' });
  });

  it('rejects an input above the pixel limit BEFORE decode and does not crash the process', async () => {
    const src = await writeFixture(await rasterBuffer(200, 200, 'jpeg'), 'jpg'); // 40,000px
    const result = await generateDisplayDerivativeBuffer(src, { maxInputPixels: 1000 });
    expect(result).toEqual({ mode: 'failed', reason: 'pixel-limit-exceeded' });
  });

  it('resolveMaxInputPixels defaults to 50,000,000 and is overridable via IMAGE_DERIVATIVE_MAX_PIXELS', () => {
    const prev = process.env.IMAGE_DERIVATIVE_MAX_PIXELS;
    try {
      delete process.env.IMAGE_DERIVATIVE_MAX_PIXELS;
      expect(resolveMaxInputPixels()).toBe(50_000_000);
      process.env.IMAGE_DERIVATIVE_MAX_PIXELS = '1234';
      expect(resolveMaxInputPixels()).toBe(1234);
      process.env.IMAGE_DERIVATIVE_MAX_PIXELS = 'not-a-number';
      expect(resolveMaxInputPixels()).toBe(50_000_000);
    } finally {
      if (prev === undefined) delete process.env.IMAGE_DERIVATIVE_MAX_PIXELS;
      else process.env.IMAGE_DERIVATIVE_MAX_PIXELS = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// Key naming
// ---------------------------------------------------------------------------

describe('storage key naming', () => {
  it('builds the deterministic display-v1 key for a given ext', () => {
    expect(buildDisplayDerivativeKey('page1', 'att1', 'jpg')).toBe('attachment/page1/derivatives/att1/display-v1.jpg');
    expect(buildDisplayDerivativeKey('page1', 'att1', 'webp')).toBe('attachment/page1/derivatives/att1/display-v1.webp');
  });

  it('enumerates exactly the 3 v1 extension candidates', () => {
    expect(displayDerivativeKeyCandidates('p', 'a')).toEqual([
      'attachment/p/derivatives/a/display-v1.jpg',
      'attachment/p/derivatives/a/display-v1.png',
      'attachment/p/derivatives/a/display-v1.webp',
    ]);
  });
});

// ---------------------------------------------------------------------------
// generateAndPublishDisplayDerivative — write orchestration (spec §7)
// ---------------------------------------------------------------------------

describe('generateAndPublishDisplayDerivative', () => {
  const PATH_PREFIX = '/image-derivative-orchestration-test/';
  let accessToken: string;

  beforeAll(async () => {
    const owner = await createTestUser({ name: 'Derivative Owner', username: 'derivOwner', email: 'deriv-owner@example.com' });
    accessToken = owner.accessToken;
  });

  afterEach(async () => {
    const Page = crowi.model('Page');
    const Attachment = crowi.model('Attachment');
    const filter = { path: { $regex: `^${PATH_PREFIX}` } };
    const pages = await Page.find(filter).select('_id').lean();
    const pageIds = pages.map((p: { _id: Types.ObjectId }) => p._id);
    await Promise.all([Page.deleteMany(filter), Attachment.deleteMany({ page: { $in: pageIds } })]);
  });

  const makeAttachment = async (suffix: string) => {
    const page = await createPageViaApi(accessToken, `${PATH_PREFIX}${suffix}`, '# x');
    const Attachment = crowi.model('Attachment');
    const attachment = await Attachment.create({
      page: new Types.ObjectId(page._id),
      filePath: `attachment/${page._id}/original-${suffix}.jpg`,
      fileName: `${suffix}.jpg`,
      originalName: `${suffix}.jpg`,
      fileFormat: 'image/jpeg',
      fileSize: 123,
    });
    return { page, attachment };
  };

  it('put -> conditional update -> publishes derivatives.display on the Attachment row', async () => {
    const { page, attachment } = await makeAttachment('publish');
    const src = await writeFixture(await rasterBuffer(2000, 1000, 'jpeg'), 'jpg');

    const { derivative, published } = await generateAndPublishDisplayDerivative({
      crowi,
      attachmentId: attachment._id,
      pageId: new Types.ObjectId(page._id),
      sourcePath: src,
      oldFilePath: undefined,
    });

    expect(published).toBe(true);
    expect(derivative.mode).toBe('resized');
    expect(derivative.recipeVersion).toBe(DISPLAY_DERIVATIVE_RECIPE_VERSION);
    expect(derivative.filePath).toBe(buildDisplayDerivativeKey(page._id, attachment._id.toString(), 'jpg'));
    expect(derivative.format).toBe('image/jpeg');

    const stored = await crowi.model('Attachment').findById(attachment._id);
    expect(stored?.derivatives?.display?.mode).toBe('resized');
    expect(stored?.derivatives?.display?.filePath).toBe(derivative.filePath);

    // The object genuinely exists in storage.
    const driver = crowi.getPlugins().active.storage;
    if (!driver) throw new Error('storage driver missing in test env');
    const stream = await driver.get(derivative.filePath as string);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).length).toBe(derivative.size);
  });

  it('publishes a non-resized classification (passthrough) with no filePath and no storage write', async () => {
    const { page, attachment } = await makeAttachment('passthrough');
    const src = await writeFixture(await rasterBuffer(100, 100, 'jpeg'), 'jpg');

    const { derivative, published } = await generateAndPublishDisplayDerivative({
      crowi,
      attachmentId: attachment._id,
      pageId: new Types.ObjectId(page._id),
      sourcePath: src,
      oldFilePath: undefined,
    });

    expect(published).toBe(true);
    expect(derivative).toMatchObject({ mode: 'passthrough', reason: 'within-target-width' });
    expect(derivative.filePath).toBeUndefined();
  });

  it('matchedCount===0 (row deleted mid-flight): compensates by deleting the just-put object and does not publish', async () => {
    const { page, attachment } = await makeAttachment('race');
    const src = await writeFixture(await rasterBuffer(2000, 1000, 'jpeg'), 'jpg');

    // Simulate the row having been deleted between the caller's read and
    // this call (spec §10 case B) by removing it up front.
    await crowi.model('Attachment').deleteOne({ _id: attachment._id });

    const expectedKey = buildDisplayDerivativeKey(page._id, attachment._id.toString(), 'jpg');
    const { published } = await generateAndPublishDisplayDerivative({
      crowi,
      attachmentId: attachment._id,
      pageId: new Types.ObjectId(page._id),
      sourcePath: src,
      oldFilePath: undefined,
    });

    expect(published).toBe(false);

    // Compensating delete: the object `put` just before the failed publish must be gone.
    const driver = crowi.getPlugins().active.storage;
    if (!driver) throw new Error('storage driver missing in test env');
    await expect(driver.get(expectedKey)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // AC7: old-key cleanup does NOT look at the new record's mode — it must
  // fire on EVERY resized -> {passthrough, unsupported, failed} transition,
  // not just the one covered by an earlier revision of this test
  // (resized -> passthrough).
  const MODE_TRANSITION_CASES: Array<{
    label: string;
    suffix: string;
    buildSrc: () => Promise<string>;
    expectedMode: string;
  }> = [
    {
      label: 'resized -> passthrough (within-target-width)',
      suffix: 'mode-transition-passthrough',
      buildSrc: async () => writeFixture(await rasterBuffer(100, 100, 'jpeg'), 'jpg'),
      expectedMode: 'passthrough',
    },
    {
      label: 'resized -> unsupported (gif)',
      suffix: 'mode-transition-unsupported',
      buildSrc: async () =>
        writeFixture(
          await sharp({ create: { width: 2000, height: 900, channels: 3, background: { r: 1, g: 2, b: 3 } } })
            .gif()
            .toBuffer(),
          'gif',
        ),
      expectedMode: 'unsupported',
    },
    {
      label: 'resized -> failed (decode-error)',
      suffix: 'mode-transition-failed',
      buildSrc: async () => writeFixture(Buffer.from('this is not an image, just garbage bytes for testing purposes'), 'bin'),
      expectedMode: 'failed',
    },
  ];

  it.each(MODE_TRANSITION_CASES)('deletes the OLD derivative key even when the new classification is $label (mode transition)', async ({
    suffix,
    buildSrc,
    expectedMode,
  }) => {
    const { page, attachment } = await makeAttachment(suffix);
    const driver = crowi.getPlugins().active.storage;
    if (!driver) throw new Error('storage driver missing in test env');

    const oldKey = buildDisplayDerivativeKey(page._id, attachment._id.toString(), 'jpg');
    await driver.put(oldKey, Buffer.from('stale derivative bytes'), { contentType: 'image/jpeg' });

    const src = await buildSrc();
    const { derivative, published } = await generateAndPublishDisplayDerivative({
      crowi,
      attachmentId: attachment._id,
      pageId: new Types.ObjectId(page._id),
      sourcePath: src,
      oldFilePath: oldKey,
    });

    expect(published).toBe(true);
    expect(derivative.mode).toBe(expectedMode);
    await expect(driver.get(oldKey)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('persists mode:failed/reason:pixel-limit-exceeded onto the Attachment row via publish — not just the pure generator return value (AC4)', async () => {
    const { page, attachment } = await makeAttachment('pixel-limit-persisted');
    const src = await writeFixture(await rasterBuffer(200, 200, 'jpeg'), 'jpg'); // 40,000px

    const prev = process.env.IMAGE_DERIVATIVE_MAX_PIXELS;
    process.env.IMAGE_DERIVATIVE_MAX_PIXELS = '1000';
    try {
      const { derivative, published } = await generateAndPublishDisplayDerivative({
        crowi,
        attachmentId: attachment._id,
        pageId: new Types.ObjectId(page._id),
        sourcePath: src,
        oldFilePath: undefined,
      });
      expect(published).toBe(true);
      expect(derivative).toMatchObject({ mode: 'failed', reason: 'pixel-limit-exceeded' });
    } finally {
      if (prev === undefined) delete process.env.IMAGE_DERIVATIVE_MAX_PIXELS;
      else process.env.IMAGE_DERIVATIVE_MAX_PIXELS = prev;
    }

    // The point of this test: the classification actually landed on the
    // Attachment DOCUMENT (via the conditional `updateOne` publish), not
    // just in the in-memory return value — `generateDisplayDerivativeBuffer`
    // (the pure function) is covered separately above, but never touches Mongo.
    const stored = await crowi.model('Attachment').findById(attachment._id);
    expect(stored?.derivatives?.display?.mode).toBe('failed');
    expect(stored?.derivatives?.display?.reason).toBe('pixel-limit-exceeded');
  });

  // AC7: if the publish `updateOne` ITSELF throws (as opposed to resolving
  // with `matchedCount === 0`, which `publishDerivative` already
  // compensates for on its own), the derivative object that was just `put`
  // to storage must not be silently orphaned.
  it('compensates by deleting the just-put object when the publish updateOne call throws (not just matchedCount===0), then rethrows', async () => {
    const { page, attachment } = await makeAttachment('publish-throws');
    const src = await writeFixture(await rasterBuffer(2000, 1000, 'jpeg'), 'jpg');
    const driver = crowi.getPlugins().active.storage;
    if (!driver) throw new Error('storage driver missing in test env');

    const Attachment = crowi.model('Attachment');
    const updateOneSpy = jest.spyOn(Attachment, 'updateOne').mockImplementationOnce(async () => {
      throw new Error('simulated Mongo connectivity blip during publish');
    });

    const expectedKey = buildDisplayDerivativeKey(page._id, attachment._id.toString(), 'jpg');
    try {
      await expect(
        generateAndPublishDisplayDerivative({
          crowi,
          attachmentId: attachment._id,
          pageId: new Types.ObjectId(page._id),
          sourcePath: src,
          oldFilePath: undefined,
        }),
      ).rejects.toThrow('simulated Mongo connectivity blip during publish');
    } finally {
      updateOneSpy.mockRestore();
    }

    // The object WAS put to storage before the throw — proven by the
    // compensating delete actually removing it (an ENOENT here would mean
    // the compensating delete never ran and the "put succeeded" premise of
    // this test was false).
    await expect(driver.get(expectedKey)).rejects.toMatchObject({ code: 'ENOENT' });

    // The Attachment row itself was never touched by the failed publish.
    const doc = await Attachment.findById(attachment._id);
    expect(doc?.derivatives).toBeUndefined();
  });

  it('via the upload entry point, a publish-updateOne throw still ends in mode:failed/reason:unknown-error persisted, with no orphaned object, and the upload response never rejects', async () => {
    const { page, attachment } = await makeAttachment('publish-throws-upload');
    const src = await writeFixture(await rasterBuffer(2000, 1000, 'jpeg'), 'jpg');
    const driver = crowi.getPlugins().active.storage;
    if (!driver) throw new Error('storage driver missing in test env');

    const Attachment = crowi.model('Attachment');
    const updateOneSpy = jest.spyOn(Attachment, 'updateOne').mockImplementationOnce(async () => {
      throw new Error('simulated Mongo connectivity blip during publish');
    });

    const expectedKey = buildDisplayDerivativeKey(page._id, attachment._id.toString(), 'jpg');
    let result: Awaited<ReturnType<typeof generateDisplayDerivativeForUpload>>;
    try {
      result = await generateDisplayDerivativeForUpload({
        crowi,
        attachmentId: attachment._id,
        pageId: new Types.ObjectId(page._id),
        sourcePath: src,
        oldFilePath: undefined,
      });
    } finally {
      updateOneSpy.mockRestore();
    }

    // Never rejects — the upload response is not affected.
    expect(result.published).toBe(true);
    expect(result.derivative).toMatchObject({ mode: 'failed', reason: 'unknown-error' });

    // No orphan: the object put by the failed first attempt is gone …
    await expect(driver.get(expectedKey)).rejects.toMatchObject({ code: 'ENOENT' });
    // … and the retried publish-a-failure DID land on the document (the
    // spy only intercepted the FIRST updateOne call via mockImplementationOnce
    // — the retry inside `publishFailureOnly` goes through un-mocked).
    const stored = await Attachment.findById(attachment._id);
    expect(stored?.derivatives?.display?.mode).toBe('failed');
    expect(stored?.derivatives?.display?.reason).toBe('unknown-error');
  });
});

// ---------------------------------------------------------------------------
// Schema validation (spec §6) — the storage layer enum lists are sourced
// from `image-display-derivative.ts`'s own classification tables (never
// hand-duplicated), and `runValidators: true` on the publish `updateOne`
// (Mongoose does NOT validate `$set` payloads by default) is what actually
// makes them bite on the one write path that sets `derivatives.display`
// post-creation.
// ---------------------------------------------------------------------------

describe('Attachment.derivatives.display schema validation', () => {
  const PATH_PREFIX = '/image-derivative-schema-validation-test/';
  let accessToken: string;

  beforeAll(async () => {
    const owner = await createTestUser({ name: 'Schema Validation Owner', username: 'schemaValidationOwner', email: 'schema-validation-owner@example.com' });
    accessToken = owner.accessToken;
  });

  afterEach(async () => {
    const Page = crowi.model('Page');
    const Attachment = crowi.model('Attachment');
    const filter = { path: { $regex: `^${PATH_PREFIX}` } };
    const pages = await Page.find(filter).select('_id').lean();
    const pageIds = pages.map((p: { _id: Types.ObjectId }) => p._id);
    await Promise.all([Page.deleteMany(filter), Attachment.deleteMany({ page: { $in: pageIds } })]);
  });

  const makeAttachment = async (suffix: string) => {
    const page = await createPageViaApi(accessToken, `${PATH_PREFIX}${suffix}`, '# x');
    const Attachment = crowi.model('Attachment');
    const attachment = await Attachment.create({
      page: new Types.ObjectId(page._id),
      filePath: `attachment/${page._id}/original-${suffix}.jpg`,
      fileName: `${suffix}.jpg`,
      originalName: `${suffix}.jpg`,
      fileFormat: 'image/jpeg',
      fileSize: 123,
    });
    return { attachment };
  };

  it('rejects a `format` that is a sharp decoder identifier instead of a fixed MIME string, on the publish updateOne', async () => {
    const { attachment } = await makeAttachment('bad-format');
    const Attachment = crowi.model('Attachment');
    await expect(
      Attachment.updateOne(
        { _id: attachment._id },
        {
          $set: {
            'derivatives.display': {
              recipeVersion: DISPLAY_DERIVATIVE_RECIPE_VERSION,
              mode: 'resized',
              filePath: 'attachment/x/derivatives/y/display-v1.jpg',
              format: 'jpeg', // sharp decoder id, NOT one of DISPLAY_DERIVATIVE_MIME_TYPES — must be rejected
              width: 10,
              height: 10,
              size: 10,
              generatedAt: new Date(),
            },
          },
        },
        { upsert: false, runValidators: true },
      ),
    ).rejects.toThrow();

    // The invalid write never landed.
    const stored = await Attachment.findById(attachment._id);
    expect(stored?.derivatives).toBeUndefined();
  });

  it('rejects a `reason` outside the closed classification set, on the publish updateOne', async () => {
    const { attachment } = await makeAttachment('bad-reason');
    const Attachment = crowi.model('Attachment');
    await expect(
      Attachment.updateOne(
        { _id: attachment._id },
        {
          $set: {
            'derivatives.display': { recipeVersion: DISPLAY_DERIVATIVE_RECIPE_VERSION, mode: 'failed', reason: 'not-a-real-reason', generatedAt: new Date() },
          },
        },
        { upsert: false, runValidators: true },
      ),
    ).rejects.toThrow();
  });

  it('rejects a `recipeVersion` other than the current literal, on the publish updateOne', async () => {
    const { attachment } = await makeAttachment('bad-recipe-version');
    const Attachment = crowi.model('Attachment');
    await expect(
      Attachment.updateOne(
        { _id: attachment._id },
        { $set: { 'derivatives.display': { recipeVersion: 999, mode: 'passthrough', reason: 'within-target-width', generatedAt: new Date() } } },
        { upsert: false, runValidators: true },
      ),
    ).rejects.toThrow();
  });

  it('accepts every real MIME value the generator can produce (sanity — the enum is not stricter than reality)', async () => {
    for (const format of DISPLAY_DERIVATIVE_MIME_TYPES) {
      const { attachment } = await makeAttachment(`accept-${format.replace('/', '-')}`);
      const Attachment = crowi.model('Attachment');
      const result = await Attachment.updateOne(
        { _id: attachment._id },
        {
          $set: {
            'derivatives.display': {
              recipeVersion: DISPLAY_DERIVATIVE_RECIPE_VERSION,
              mode: 'resized',
              filePath: 'attachment/x/derivatives/y/display-v1.jpg',
              format,
              width: 10,
              height: 10,
              size: 10,
              generatedAt: new Date(),
            },
          },
        },
        { upsert: false, runValidators: true },
      );
      expect(result.matchedCount).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Admission semaphore (spec §8) — upload paths only. Now the shared
// `Semaphore` (`src/util/semaphore.ts`, feature-renderer-core-util-dedup) —
// generic queue-cap + wait-timeout coverage lives in `fetch-og.test.ts`;
// the tests below focus on THIS module's own wiring/config knobs plus the
// queue-length cap this consolidation newly adds to the upload admission
// path (it previously had none — an unbounded-wait-queue defect).
// ---------------------------------------------------------------------------

describe('upload admission semaphore', () => {
  it('grants immediately while capacity remains', async () => {
    const sem = new Semaphore(2, 10, 1000);
    await expect(sem.acquire()).resolves.toMatchObject({ ok: true });
    await expect(sem.acquire()).resolves.toMatchObject({ ok: true });
  });

  it('queues past capacity and grants once a slot is released', async () => {
    const sem = new Semaphore(1, 10, 2000);
    const first = await sem.acquire();
    expect(first.ok).toBe(true);

    const pending = sem.acquire();
    // Give the pending acquire a couple of ticks to actually queue.
    await new Promise((resolve) => setImmediate(resolve));
    if (first.ok) first.release();

    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it('resolves { ok: false } once the wait deadline elapses without a free slot', async () => {
    const sem = new Semaphore(1, 10, 1000);
    const first = await sem.acquire();
    expect(first.ok).toBe(true);

    const result = await sem.acquire(30);
    expect(result).toEqual({ ok: false });
  });

  it('resolveAdmissionConcurrency / resolveAdmissionTimeoutMs default and are overridable', () => {
    const prevC = process.env.IMAGE_DERIVATIVE_ADMISSION_CONCURRENCY;
    const prevT = process.env.IMAGE_DERIVATIVE_ADMISSION_TIMEOUT_MS;
    try {
      delete process.env.IMAGE_DERIVATIVE_ADMISSION_CONCURRENCY;
      delete process.env.IMAGE_DERIVATIVE_ADMISSION_TIMEOUT_MS;
      expect(resolveAdmissionConcurrency()).toBe(2);
      expect(resolveAdmissionTimeoutMs()).toBe(5000);

      process.env.IMAGE_DERIVATIVE_ADMISSION_CONCURRENCY = '5';
      process.env.IMAGE_DERIVATIVE_ADMISSION_TIMEOUT_MS = '1500';
      expect(resolveAdmissionConcurrency()).toBe(5);
      expect(resolveAdmissionTimeoutMs()).toBe(1500);
    } finally {
      if (prevC === undefined) delete process.env.IMAGE_DERIVATIVE_ADMISSION_CONCURRENCY;
      else process.env.IMAGE_DERIVATIVE_ADMISSION_CONCURRENCY = prevC;
      if (prevT === undefined) delete process.env.IMAGE_DERIVATIVE_ADMISSION_TIMEOUT_MS;
      else process.env.IMAGE_DERIVATIVE_ADMISSION_TIMEOUT_MS = prevT;
    }
  });

  it(`caps the wait queue at ADMISSION_QUEUE_LIMIT (${ADMISSION_QUEUE_LIMIT}) — the pre-existing unbounded-queue defect this consolidation fixes`, async () => {
    jest.useFakeTimers();
    try {
      // The actual production capacity — proves the cap holds with the
      // real configured concurrency, not just a contrived small one.
      const capacity = resolveAdmissionConcurrency();
      const sem = new Semaphore(capacity, ADMISSION_QUEUE_LIMIT, 10_000);

      // 5 more than the semaphore can ever admit at once (active + queued).
      const EXTRA_OVER_CAP = 5;
      const TOTAL = capacity + ADMISSION_QUEUE_LIMIT + EXTRA_OVER_CAP;

      let settledCount = 0;
      const calls = Array.from({ length: TOTAL }, () => {
        const p = sem.acquire();
        p.then(() => {
          settledCount++;
        });
        return p;
      });

      // Let every dispatch's synchronous accept/queue/reject decision run
      // to completion before any clock advance — the queue-length cap
      // must reject the overflow WITHOUT any timer ever firing.
      await jest.advanceTimersByTimeAsync(0);

      // Only the `capacity` active grants + the over-cap overflow have
      // settled so far — the `ADMISSION_QUEUE_LIMIT` queued acquisitions
      // are still genuinely pending (never rejected as unbounded pile-up,
      // but also not yet granted since nothing has released a slot).
      expect(settledCount).toBe(capacity + EXTRA_OVER_CAP);

      // Advance past the wait deadline so every queued acquisition times
      // out too (nothing ever releases the `capacity` active slots here).
      await jest.advanceTimersByTimeAsync(10_000);

      const results = await Promise.all(calls);
      expect(settledCount).toBe(TOTAL);
      const granted = results.filter((r) => r.ok);
      const rejected = results.filter((r) => !r.ok);
      expect(granted).toHaveLength(capacity);
      expect(rejected).toHaveLength(ADMISSION_QUEUE_LIMIT + EXTRA_OVER_CAP);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// generateDisplayDerivativeForUpload — the upload-only entry point. Must
// NEVER reject and must always persist a classification.
// ---------------------------------------------------------------------------

describe('generateDisplayDerivativeForUpload', () => {
  const PATH_PREFIX = '/image-derivative-upload-entrypoint-test/';
  let accessToken: string;

  beforeAll(async () => {
    const owner = await createTestUser({ name: 'Upload Entry Owner', username: 'uploadEntryOwner', email: 'upload-entry-owner@example.com' });
    accessToken = owner.accessToken;
  });

  afterEach(async () => {
    const Page = crowi.model('Page');
    const Attachment = crowi.model('Attachment');
    const filter = { path: { $regex: `^${PATH_PREFIX}` } };
    const pages = await Page.find(filter).select('_id').lean();
    const pageIds = pages.map((p: { _id: Types.ObjectId }) => p._id);
    await Promise.all([Page.deleteMany(filter), Attachment.deleteMany({ page: { $in: pageIds } })]);
  });

  const makeAttachment = async (suffix: string) => {
    const page = await createPageViaApi(accessToken, `${PATH_PREFIX}${suffix}`, '# x');
    const Attachment = crowi.model('Attachment');
    const attachment = await Attachment.create({
      page: new Types.ObjectId(page._id),
      filePath: `attachment/${page._id}/original-${suffix}.jpg`,
      fileName: `${suffix}.jpg`,
      originalName: `${suffix}.jpg`,
      fileFormat: 'image/jpeg',
      fileSize: 123,
    });
    return { page, attachment };
  };

  it('records mode:failed/reason:admission-timeout and skips generation entirely when admission is denied', async () => {
    const { page, attachment } = await makeAttachment('admission-timeout');
    const src = await writeFixture(await rasterBuffer(2000, 1000, 'jpeg'), 'jpg');

    const deniedAdmission: Pick<Semaphore, 'acquire'> = {
      acquire: async () => ({ ok: false }),
    };

    const { derivative, published } = await generateDisplayDerivativeForUpload(
      { crowi, attachmentId: attachment._id, pageId: new Types.ObjectId(page._id), sourcePath: src, oldFilePath: undefined },
      deniedAdmission,
    );

    expect(published).toBe(true);
    expect(derivative).toMatchObject({ mode: 'failed', reason: 'admission-timeout' });

    // No storage write should have happened — generation never ran.
    const driver = crowi.getPlugins().active.storage;
    if (!driver) throw new Error('storage driver missing in test env');
    for (const key of displayDerivativeKeyCandidates(page._id, attachment._id.toString())) {
      await expect(driver.get(key)).rejects.toMatchObject({ code: 'ENOENT' });
    }

    // AC4: the classification must actually land on the Attachment
    // DOCUMENT via the publish `updateOne`, not just be visible in the
    // in-memory return value above.
    const stored = await crowi.model('Attachment').findById(attachment._id);
    expect(stored?.derivatives?.display?.mode).toBe('failed');
    expect(stored?.derivatives?.display?.reason).toBe('admission-timeout');
  });

  it('proceeds normally and releases the slot when admission is granted', async () => {
    const { page, attachment } = await makeAttachment('admission-ok');
    const src = await writeFixture(await rasterBuffer(2000, 1000, 'jpeg'), 'jpg');

    const sem = new Semaphore(1, 10, 1000);
    const { derivative, published } = await generateDisplayDerivativeForUpload(
      { crowi, attachmentId: attachment._id, pageId: new Types.ObjectId(page._id), sourcePath: src, oldFilePath: undefined },
      sem,
    );

    expect(published).toBe(true);
    expect(derivative.mode).toBe('resized');
    // The slot was released — a second acquire should succeed immediately.
    await expect(sem.acquire(10)).resolves.toMatchObject({ ok: true });
  });

  it('never rejects even when the source path does not exist, and persists a failed classification', async () => {
    const { page, attachment } = await makeAttachment('missing-source');
    const missingPath = path.join(tmpDir, 'does-not-exist.jpg');

    await expect(
      generateDisplayDerivativeForUpload({
        crowi,
        attachmentId: attachment._id,
        pageId: new Types.ObjectId(page._id),
        sourcePath: missingPath,
        oldFilePath: undefined,
      }),
    ).resolves.toMatchObject({ published: true, derivative: { mode: 'failed' } });

    const stored = await crowi.model('Attachment').findById(attachment._id);
    expect(stored?.derivatives?.display?.mode).toBe('failed');
  });

  it('resolves quickly on admission-timeout instead of waiting out a long generation (upload response is not blocked)', async () => {
    const { page, attachment } = await makeAttachment('admission-timeout-fast');
    const src = await writeFixture(await rasterBuffer(2000, 1000, 'jpeg'), 'jpg');

    const deniedAdmission: Pick<Semaphore, 'acquire'> = {
      acquire: async () => ({ ok: false }),
    };

    const start = Date.now();
    await generateDisplayDerivativeForUpload(
      { crowi, attachmentId: attachment._id, pageId: new Types.ObjectId(page._id), sourcePath: src, oldFilePath: undefined },
      deniedAdmission,
    );
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// Attachment.removeAttachment + delete/generate interleaving (spec §10),
// run against BOTH storage drivers.
// ---------------------------------------------------------------------------

describe.each<DriverKind>(['local', 's3'])('Attachment deletion / display-derivative generation interleaving — driver: %s', (kind) => {
  const PATH_PREFIX = `/image-derivative-interleaving-${kind}-test/`;
  let accessToken: string;

  beforeAll(async () => {
    const owner = await createTestUser({ name: `Interleave Owner ${kind}`, username: `interleaveOwner${kind}`, email: `interleave-owner-${kind}@example.com` });
    accessToken = owner.accessToken;
  });

  afterEach(async () => {
    const Page = crowi.model('Page');
    const Attachment = crowi.model('Attachment');
    const filter = { path: { $regex: `^${PATH_PREFIX}` } };
    const pages = await Page.find(filter).select('_id').lean();
    const pageIds = pages.map((p: { _id: Types.ObjectId }) => p._id);
    await Promise.all([Page.deleteMany(filter), Attachment.deleteMany({ page: { $in: pageIds } })]);
  });

  const makeAttachment = async (suffix: string, driver: StorageDriver) => {
    const page = await createPageViaApi(accessToken, `${PATH_PREFIX}${suffix}`, '# x');
    const originalKey = `attachment/${page._id}/original-${suffix}.jpg`;
    await driver.put(originalKey, Buffer.from('original bytes'), { contentType: 'image/jpeg' });
    const Attachment = crowi.model('Attachment');
    const attachment = await Attachment.create({
      page: new Types.ObjectId(page._id),
      filePath: originalKey,
      fileName: `${suffix}.jpg`,
      originalName: `${suffix}.jpg`,
      fileFormat: 'image/jpeg',
      fileSize: 123,
    });
    return { page, attachment, originalKey };
  };

  it('case A — generation publishes before delete: findOneAndDelete captures the LATEST derivatives.display (not a stale caller snapshot), and delete removes both original + derivative', async () => {
    await withDriver(kind, async (driver) => {
      const { page, attachment, originalKey } = await makeAttachment('case-a', driver);
      const staleSnapshot = await crowi.model('Attachment').findById(attachment._id); // read BEFORE generation publishes
      if (!staleSnapshot) throw new Error('unreachable');

      const src = await writeFixture(await rasterBuffer(2000, 1000, 'jpeg'), 'jpg');
      const { derivative } = await generateAndPublishDisplayDerivative({
        crowi,
        attachmentId: attachment._id,
        pageId: new Types.ObjectId(page._id),
        sourcePath: src,
        oldFilePath: undefined,
      });
      expect(derivative.mode).toBe('resized');
      const derivativeKey = derivative.filePath as string;

      // Pass the STALE (pre-generation) snapshot — `removeAttachment` must
      // re-read via `findOneAndDelete` rather than trust it, or it would
      // miss the derivative published moments after this snapshot was read.
      await crowi.model('Attachment').removeAttachment(staleSnapshot);

      expect(await crowi.model('Attachment').findById(attachment._id)).toBeNull();
      await expectMissingObject(kind, driver.get(originalKey));
      await expectMissingObject(kind, driver.get(derivativeKey));
    });
  });

  it("case B — delete completes before the generator's publish: the generator's own compensating delete removes its orphaned put (no leak)", async () => {
    await withDriver(kind, async (driver) => {
      const { page, attachment, originalKey } = await makeAttachment('case-b', driver);

      // Delete first — no `derivatives.display` exists yet, so the
      // deterministic-key sweep in `removeAttachment` is a idempotent no-op.
      await crowi.model('Attachment').removeAttachment(attachment);
      expect(await crowi.model('Attachment').findById(attachment._id)).toBeNull();
      await expectMissingObject(kind, driver.get(originalKey));

      // The generator runs AFTER the row is already gone.
      const src = await writeFixture(await rasterBuffer(2000, 1000, 'jpeg'), 'jpg');
      const expectedKey = buildDisplayDerivativeKey(page._id, attachment._id.toString(), 'jpg');
      const { published } = await generateAndPublishDisplayDerivative({
        crowi,
        attachmentId: attachment._id,
        pageId: new Types.ObjectId(page._id),
        sourcePath: src,
        oldFilePath: undefined,
      });

      expect(published).toBe(false);
      // Compensating delete: no orphaned object left behind.
      await expectMissingObject(kind, driver.get(expectedKey));
    });
  });

  // Case C is a genuine race between the ACTUAL `Attachment.updateOne`
  // (publish) and `Attachment.findOneAndDelete` (delete-row) Mongo calls —
  // not just two async functions started together. A naive `Promise.all`
  // of `removeAttachment(...)` and `generateAndPublishDisplayDerivative(...)`
  // is NOT a genuine test of this: the generator does real work (metadata
  // read, decode, resize, re-encode, storage `put`) before it ever calls
  // `updateOne`, while `removeAttachment`'s `findOneAndDelete` is the very
  // first thing it does — so in practice `findOneAndDelete` always commits
  // first and the "race" silently collapses to case B on every run. Each
  // sub-test below uses `jest.spyOn(...).mockImplementationOnce(...)` (the
  // same race-injection idiom `models/page.test.ts` uses for its own
  // findPageById/updateGrant race) to force the two Mongo calls to
  // interleave in a SPECIFIC, controlled order — deterministically
  // exercising both directions of the race instead of leaving it to chance.

  it("case C-1 — the generator's publish `updateOne` is made to commit WHILE `removeAttachment`'s `findOneAndDelete` is in flight (forced interleave, not pre-sequenced like case A): `findOneAndDelete` captures the freshly-published derivative and both original + derivative are removed", async () => {
    await withDriver(kind, async (driver) => {
      const { page, attachment, originalKey } = await makeAttachment('case-c1-publish-wins', driver);
      const src = await writeFixture(await rasterBuffer(2000, 1000, 'jpeg'), 'jpg');
      const Attachment = crowi.model('Attachment');
      const realFindOneAndDelete = Attachment.findOneAndDelete.bind(Attachment);

      let generateResult: GenerateAndPublishResult | undefined;
      const findOneAndDeleteSpy = jest
        .spyOn(Attachment, 'findOneAndDelete')
        .mockImplementationOnce(async (...args: Parameters<typeof realFindOneAndDelete>) => {
          // Before the row is actually deleted, let the generator's full
          // put -> `updateOne` publish land on THIS SAME `_id` — the
          // `findOneAndDelete` call below (the real implementation) is what
          // must observe it, not a caller-supplied stale snapshot.
          generateResult = await generateAndPublishDisplayDerivative({
            crowi,
            attachmentId: attachment._id,
            pageId: new Types.ObjectId(page._id),
            sourcePath: src,
            oldFilePath: undefined,
          });
          return realFindOneAndDelete(...args);
        });

      try {
        await Attachment.removeAttachment(attachment);
      } finally {
        findOneAndDeleteSpy.mockRestore();
      }

      if (!generateResult) throw new Error('unreachable: findOneAndDelete mock never invoked');
      expect(generateResult.derivative.mode).toBe('resized');
      expect(generateResult.published).toBe(true);
      const derivativeKey = generateResult.derivative.filePath as string;

      expect(await Attachment.findById(attachment._id)).toBeNull();
      await expectMissingObject(kind, driver.get(originalKey));
      await expectMissingObject(kind, driver.get(derivativeKey));
    });
  });

  it("case C-2 — `removeAttachment`'s `findOneAndDelete` is made to commit WHILE the generator's publish `updateOne` is in flight (forced interleave, not pre-sequenced like case B): the generator's own compensating delete removes its already-put derivative (no orphan)", async () => {
    await withDriver(kind, async (driver) => {
      const { page, attachment, originalKey } = await makeAttachment('case-c2-delete-wins', driver);
      const src = await writeFixture(await rasterBuffer(2000, 1000, 'jpeg'), 'jpg');
      const Attachment = crowi.model('Attachment');
      const realUpdateOne = Attachment.updateOne.bind(Attachment);
      const expectedDerivativeKey = buildDisplayDerivativeKey(page._id, attachment._id.toString(), 'jpg');

      const updateOneSpy = jest.spyOn(Attachment, 'updateOne').mockImplementationOnce(async (...args: Parameters<typeof realUpdateOne>) => {
        // Before the publish's conditional update actually reaches Mongo,
        // let a concurrent delete commit first — by the time the real
        // `updateOne` below runs, the row for this `_id` is already gone.
        await Attachment.removeAttachment(attachment);
        return realUpdateOne(...args);
      });

      let generateResult: GenerateAndPublishResult;
      try {
        generateResult = await generateAndPublishDisplayDerivative({
          crowi,
          attachmentId: attachment._id,
          pageId: new Types.ObjectId(page._id),
          sourcePath: src,
          oldFilePath: undefined,
        });
      } finally {
        updateOneSpy.mockRestore();
      }

      // The generator's `put` still ran to completion (it happens BEFORE
      // `updateOne` in the real implementation) — only the publish itself
      // lost the race.
      expect(generateResult.derivative.mode).toBe('resized');
      expect(generateResult.published).toBe(false);

      expect(await Attachment.findById(attachment._id)).toBeNull();
      await expectMissingObject(kind, driver.get(originalKey));
      await expectMissingObject(kind, driver.get(expectedDerivativeKey));
    });
  });

  it("case D — put succeeded but the generator crashed before publish: removeAttachment's deterministic-key sweep still catches the orphan", async () => {
    await withDriver(kind, async (driver) => {
      const { page, attachment, originalKey } = await makeAttachment('case-d', driver);

      // Simulate "put succeeded, process died before Attachment.updateOne
      // ran" — `derivatives.display` stays unset on the row.
      const orphanKey = buildDisplayDerivativeKey(page._id, attachment._id.toString(), 'jpg');
      await driver.put(orphanKey, Buffer.from('orphaned derivative bytes'), { contentType: 'image/jpeg' });

      await crowi.model('Attachment').removeAttachment(attachment);

      expect(await crowi.model('Attachment').findById(attachment._id)).toBeNull();
      await expectMissingObject(kind, driver.get(originalKey));
      await expectMissingObject(kind, driver.get(orphanKey));
    });
  });

  it('original-delete failure still surfaces as a thrown error, AFTER derivative cleanup was attempted (DELETE contract unchanged)', async () => {
    await withDriver(kind, async (driver) => {
      const { page, attachment, originalKey } = await makeAttachment('original-delete-fails', driver);

      const src = await writeFixture(await rasterBuffer(2000, 1000, 'jpeg'), 'jpg');
      const { derivative } = await generateAndPublishDisplayDerivative({
        crowi,
        attachmentId: attachment._id,
        pageId: new Types.ObjectId(page._id),
        sourcePath: src,
        oldFilePath: undefined,
      });
      const derivativeKey = derivative.filePath as string;

      const realDelete = driver.delete.bind(driver);
      const deleteSpy = jest.spyOn(driver, 'delete').mockImplementation(async (key: string) => {
        if (key === originalKey) throw new Error('simulated original delete failure');
        return realDelete(key);
      });

      try {
        await expect(crowi.model('Attachment').removeAttachment(attachment)).rejects.toThrow('simulated original delete failure');
      } finally {
        deleteSpy.mockRestore();
      }

      // Row delete happened first (unaffected by the original-delete failure).
      expect(await crowi.model('Attachment').findById(attachment._id)).toBeNull();
      // Derivative cleanup was still attempted despite the original failing.
      await expectMissingObject(kind, driver.get(derivativeKey));
    });
  });

  it('removeAttachment is idempotent when the row is already gone', async () => {
    await withDriver(kind, async (driver) => {
      const { attachment } = await makeAttachment('idempotent', driver);
      await crowi.model('Attachment').removeAttachment(attachment);
      // Second call against the same (now stale) in-memory doc must not throw.
      await expect(crowi.model('Attachment').removeAttachment(attachment)).resolves.toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// AC12 — every interleaving test above `put`s and `delete`s derivative
// objects through the real driver (including S3, via `makeFakeS3Driver`'s
// actual `PutObjectCommand`/`DeleteObjectCommand`), but never actually
// `get()`s one back and verifies its CONTENT before deleting it. A broken
// or silently-no-op S3 write (e.g. a driver bug that `put()`s to the wrong
// key, or writes zero bytes) would still make every ENOENT-after-delete
// assertion above pass. These tests close that gap for both drivers.
// ---------------------------------------------------------------------------

describe.each<DriverKind>(['local', 's3'])('generateAndPublishDisplayDerivative writes a genuinely readable derivative object — driver: %s', (kind) => {
  const PATH_PREFIX = `/image-derivative-readback-${kind}-test/`;
  let accessToken: string;

  beforeAll(async () => {
    const owner = await createTestUser({ name: `Readback Owner ${kind}`, username: `readbackOwner${kind}`, email: `readback-owner-${kind}@example.com` });
    accessToken = owner.accessToken;
  });

  afterEach(async () => {
    const Page = crowi.model('Page');
    const Attachment = crowi.model('Attachment');
    const filter = { path: { $regex: `^${PATH_PREFIX}` } };
    const pages = await Page.find(filter).select('_id').lean();
    const pageIds = pages.map((p: { _id: Types.ObjectId }) => p._id);
    await Promise.all([Page.deleteMany(filter), Attachment.deleteMany({ page: { $in: pageIds } })]);
  });

  const makeAttachment = async (suffix: string) => {
    const page = await createPageViaApi(accessToken, `${PATH_PREFIX}${suffix}`, '# x');
    const Attachment = crowi.model('Attachment');
    const attachment = await Attachment.create({
      page: new Types.ObjectId(page._id),
      filePath: `attachment/${page._id}/original-${suffix}.jpg`,
      fileName: `${suffix}.jpg`,
      originalName: `${suffix}.jpg`,
      fileFormat: 'image/jpeg',
      fileSize: 123,
    });
    return { page, attachment };
  };

  it('put() actually stores retrievable bytes that decode as the reported format/dimensions (not a silent no-op write)', async () => {
    await withDriver(kind, async (driver) => {
      const { page, attachment } = await makeAttachment('readback');
      const src = await writeFixture(await rasterBuffer(2000, 1000, 'jpeg'), 'jpg');

      const { derivative } = await generateAndPublishDisplayDerivative({
        crowi,
        attachmentId: attachment._id,
        pageId: new Types.ObjectId(page._id),
        sourcePath: src,
        oldFilePath: undefined,
      });
      expect(derivative.mode).toBe('resized');
      const key = derivative.filePath as string;

      // Read it back through the REAL driver before touching it any further.
      const stream = await driver.get(key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      const readBack = Buffer.concat(chunks);
      expect(readBack.length).toBe(derivative.size);

      // Prove the bytes are a genuinely valid re-encode in the reported
      // format/dimensions, not e.g. zero bytes, garbage, or the original
      // untouched file written under the derivative's key.
      const meta = await sharp(readBack).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.width).toBe(derivative.width);
      expect(meta.height).toBe(derivative.height);

      await driver.delete(key);
      await expectMissingObject(kind, driver.get(key));
    });
  });
});

// ---------------------------------------------------------------------------
// `Attachment.findDeliveryFile` — original fallback (AC11). Phase 1
// deliberately does NOT touch the delivery handler (`/attachments/:id`,
// Phase 2's job) or `Attachment.findDeliveryFile` itself (AC1: signature and
// behaviour unchanged) — it always resolves `attachment.filePath` (the
// original), completely ignoring `derivatives`. These tests are the
// explicit local/S3 coverage that this stays true even once a
// `derivatives.display` has been generated and published, equally when
// generation never produced one (unsupported/failed/legacy attachments),
// AND when the row still claims `mode: resized` but the derivative object
// itself is missing from storage (deleted/never-truly-written underneath a
// stale row) — the reverse of the "object exists" case, and the scenario
// this fallback exists to cover.
// ---------------------------------------------------------------------------

describe.each<DriverKind>(['local', 's3'])('Attachment.findDeliveryFile — original fallback (unchanged by Phase 1) — driver: %s', (kind) => {
  const PATH_PREFIX = `/image-derivative-original-fallback-${kind}-test/`;
  let accessToken: string;

  beforeAll(async () => {
    const owner = await createTestUser({ name: `Fallback Owner ${kind}`, username: `fallbackOwner${kind}`, email: `fallback-owner-${kind}@example.com` });
    accessToken = owner.accessToken;
  });

  afterEach(async () => {
    const Page = crowi.model('Page');
    const Attachment = crowi.model('Attachment');
    const filter = { path: { $regex: `^${PATH_PREFIX}` } };
    const pages = await Page.find(filter).select('_id').lean();
    const pageIds = pages.map((p: { _id: Types.ObjectId }) => p._id);
    await Promise.all([Page.deleteMany(filter), Attachment.deleteMany({ page: { $in: pageIds } })]);
  });

  const makeAttachment = async (suffix: string, driver: StorageDriver, originalBytes: Buffer) => {
    const page = await createPageViaApi(accessToken, `${PATH_PREFIX}${suffix}`, '# x');
    const originalKey = `attachment/${page._id}/original-${suffix}.jpg`;
    await driver.put(originalKey, originalBytes, { contentType: 'image/jpeg' });
    const Attachment = crowi.model('Attachment');
    const attachment = await Attachment.create({
      page: new Types.ObjectId(page._id),
      filePath: originalKey,
      fileName: `${suffix}.jpg`,
      originalName: `${suffix}.jpg`,
      fileFormat: 'image/jpeg',
      fileSize: originalBytes.length,
    });
    return { page, attachment, originalKey };
  };

  it('resolves to the original bytes even after a display derivative has been generated and published (mode: resized)', async () => {
    await withDriver(kind, async (driver) => {
      const originalBytes = Buffer.from('genuine original bytes, not a derivative');
      const { page, attachment } = await makeAttachment('resized-present', driver, originalBytes);

      const src = await writeFixture(await rasterBuffer(2000, 1000, 'jpeg'), 'jpg');
      const { derivative } = await generateAndPublishDisplayDerivative({
        crowi,
        attachmentId: attachment._id,
        pageId: new Types.ObjectId(page._id),
        sourcePath: src,
        oldFilePath: undefined,
      });
      expect(derivative.mode).toBe('resized');
      // Sanity: the derivative object is a DIFFERENT key with DIFFERENT bytes than the original.
      expect(derivative.filePath).not.toBe(attachment.filePath);

      const stored = await crowi.model('Attachment').findById(attachment._id);
      if (!stored) throw new Error('unreachable');
      const stream = await crowi.model('Attachment').findDeliveryFile(stored);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      expect(Buffer.concat(chunks)).toEqual(originalBytes);
    });
  });

  it('resolves to the original bytes when `derivatives.display.mode` is `resized` but the derivative object itself is missing from storage (AC11 — deleted/never-truly-written underneath a stale row)', async () => {
    await withDriver(kind, async (driver) => {
      const originalBytes = Buffer.from('genuine original bytes, derivative row says resized but object is gone');
      const { page, attachment } = await makeAttachment('resized-missing-object', driver, originalBytes);

      const src = await writeFixture(await rasterBuffer(2000, 1000, 'jpeg'), 'jpg');
      const { derivative } = await generateAndPublishDisplayDerivative({
        crowi,
        attachmentId: attachment._id,
        pageId: new Types.ObjectId(page._id),
        sourcePath: src,
        oldFilePath: undefined,
      });
      expect(derivative.mode).toBe('resized');
      const derivativeKey = derivative.filePath as string;

      // Delete the derivative object directly through the driver WITHOUT
      // touching the Attachment row — `derivatives.display.mode` stays
      // `resized` and `filePath` stays populated, but a `get()` for that
      // key now fails (the exact "resized record but object missing"
      // scenario AC11 requires original-fallback coverage for).
      await driver.delete(derivativeKey);
      await expectMissingObject(kind, driver.get(derivativeKey));

      // `Attachment.findDeliveryFile` (unchanged by Phase 1 — AC1) never
      // looks at `derivatives` at all, so it must resolve the original
      // bytes here regardless, without ever attempting (or failing on) the
      // now-missing derivative object.
      const stored = await crowi.model('Attachment').findById(attachment._id);
      if (!stored) throw new Error('unreachable');
      expect(stored.derivatives?.display?.mode).toBe('resized');
      expect(stored.derivatives?.display?.filePath).toBe(derivativeKey);
      const stream = await crowi.model('Attachment').findDeliveryFile(stored);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      expect(Buffer.concat(chunks)).toEqual(originalBytes);
    });
  });

  it('resolves to the original bytes when generation classified as unsupported (no derivative object was ever created)', async () => {
    await withDriver(kind, async (driver) => {
      // A GIF is `mode: unsupported` — no object is ever `put`.
      const originalBytes = await sharp({ create: { width: 2000, height: 900, channels: 3, background: { r: 1, g: 2, b: 3 } } })
        .gif()
        .toBuffer();
      const { page, attachment } = await makeAttachment('unsupported-present', driver, originalBytes);

      const src = await writeFixture(originalBytes, 'gif');
      const { derivative } = await generateAndPublishDisplayDerivative({
        crowi,
        attachmentId: attachment._id,
        pageId: new Types.ObjectId(page._id),
        sourcePath: src,
        oldFilePath: undefined,
      });
      expect(derivative).toMatchObject({ mode: 'unsupported', reason: 'gif' });

      const stored = await crowi.model('Attachment').findById(attachment._id);
      if (!stored) throw new Error('unreachable');
      const stream = await crowi.model('Attachment').findDeliveryFile(stored);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      expect(Buffer.concat(chunks)).toEqual(originalBytes);
    });
  });

  it('resolves to the original bytes on a legacy attachment with no `derivatives` field at all (never evaluated)', async () => {
    await withDriver(kind, async (driver) => {
      const originalBytes = Buffer.from('legacy attachment, predates this feature — derivatives is undefined');
      const { attachment } = await makeAttachment('legacy-no-derivatives', driver, originalBytes);
      expect(attachment.derivatives).toBeUndefined();

      const stream = await crowi.model('Attachment').findDeliveryFile(attachment);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      expect(Buffer.concat(chunks)).toEqual(originalBytes);
    });
  });
});

describe('Attachment.removeAttachmentsByPageId (Promise.all, unchanged)', () => {
  const PATH_PREFIX = '/image-derivative-remove-by-page-test/';
  let accessToken: string;

  beforeAll(async () => {
    const owner = await createTestUser({ name: 'Remove By Page Owner', username: 'removeByPageOwner', email: 'remove-by-page-owner@example.com' });
    accessToken = owner.accessToken;
  });

  afterEach(async () => {
    const Page = crowi.model('Page');
    const Attachment = crowi.model('Attachment');
    const filter = { path: { $regex: `^${PATH_PREFIX}` } };
    const pages = await Page.find(filter).select('_id').lean();
    const pageIds = pages.map((p: { _id: Types.ObjectId }) => p._id);
    await Promise.all([Page.deleteMany(filter), Attachment.deleteMany({ page: { $in: pageIds } })]);
  });

  it("removes every attachment on the page, including each one's published derivative", async () => {
    const page = await createPageViaApi(accessToken, `${PATH_PREFIX}multi`, '# x');
    const Attachment = crowi.model('Attachment');
    const driver = crowi.getPlugins().active.storage;
    if (!driver) throw new Error('storage driver missing in test env');

    const attachments = await Promise.all(
      ['a', 'b'].map(async (suffix) => {
        const originalKey = `attachment/${page._id}/original-multi-${suffix}.jpg`;
        await driver.put(originalKey, Buffer.from('original bytes'), { contentType: 'image/jpeg' });
        return Attachment.create({
          page: new Types.ObjectId(page._id),
          filePath: originalKey,
          fileName: `multi-${suffix}.jpg`,
          originalName: `multi-${suffix}.jpg`,
          fileFormat: 'image/jpeg',
          fileSize: 10,
        });
      }),
    );

    const src = await writeFixture(await rasterBuffer(2000, 1000, 'jpeg'), 'jpg');
    const derivativeKeys = await Promise.all(
      attachments.map(async (attachment) => {
        const { derivative } = await generateAndPublishDisplayDerivative({
          crowi,
          attachmentId: attachment._id,
          pageId: new Types.ObjectId(page._id),
          sourcePath: src,
          oldFilePath: undefined,
        });
        return derivative.filePath as string;
      }),
    );

    await Attachment.removeAttachmentsByPageId(new Types.ObjectId(page._id));

    for (const attachment of attachments) {
      expect(await Attachment.findById(attachment._id)).toBeNull();
    }
    for (const key of derivativeKeys) {
      // This suite runs against the process-default active driver (local in
      // this test env, same as every other non-`describe.each` test in this
      // file — see `expectMissingObject`'s doc comment for why a
      // driver-specific shape, not a generic rejection, is asserted.
      await expect(driver.get(key)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});
