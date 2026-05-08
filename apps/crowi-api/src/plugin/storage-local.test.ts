/**
 * Integration tests for `@crowi/storage-local`'s driver. The driver
 * implementation lives in the package; we test it from here because
 * the package is a leaf workspace without its own jest setup.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createLocalDriver } from '@crowi/storage-local';

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

describe('@crowi/storage-local driver', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crowi-storage-local-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('round-trips a buffer through put / get', async () => {
    const driver = createLocalDriver({ rootDir: tmpDir });
    const { key } = await driver.put('a/b/hello.txt', Buffer.from('world', 'utf-8'), { contentType: 'text/plain' });
    expect(key).toBe('a/b/hello.txt');

    const stream = await driver.get('a/b/hello.txt');
    expect(await readAll(stream)).toBe('world');
  });

  it('round-trips a Readable through put / get', async () => {
    const driver = createLocalDriver({ rootDir: tmpDir });
    await driver.put('foo.txt', Readable.from(['hello', '-', 'streamed']), { contentType: 'text/plain' });
    const stream = await driver.get('foo.txt');
    expect(await readAll(stream)).toBe('hello-streamed');
  });

  it('creates intermediate directories on put', async () => {
    const driver = createLocalDriver({ rootDir: tmpDir });
    await driver.put('deep/nested/path/file.txt', Buffer.from('data'), { contentType: 'text/plain' });
    const stat = await fs.stat(path.join(tmpDir, 'deep', 'nested', 'path', 'file.txt'));
    expect(stat.isFile()).toBe(true);
  });

  it('throws ENOENT when reading a missing key', async () => {
    const driver = createLocalDriver({ rootDir: tmpDir });
    await expect(driver.get('nope.txt')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('delete is idempotent', async () => {
    const driver = createLocalDriver({ rootDir: tmpDir });
    await driver.put('x.txt', Buffer.from('x'), { contentType: 'text/plain' });
    await driver.delete('x.txt');
    await driver.delete('x.txt'); // second delete: no-op
    await expect(driver.get('x.txt')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects keys that escape rootDir via ..', async () => {
    const driver = createLocalDriver({ rootDir: tmpDir });
    await expect(driver.put('../escape.txt', Buffer.from('x'), { contentType: 'text/plain' })).rejects.toThrow(/outside of rootDir/);
  });

  it('rejects absolute keys outside rootDir', async () => {
    const driver = createLocalDriver({ rootDir: tmpDir });
    await expect(driver.put('/etc/passwd', Buffer.from('x'), { contentType: 'text/plain' })).rejects.toThrow(/outside of rootDir/);
  });
});
