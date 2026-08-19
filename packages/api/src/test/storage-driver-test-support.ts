import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { StorageDriver } from '@crowi/plugin-api';
import { crowi } from './setup';

/**
 * Test-only helpers shared by `util/storage-copy.test.ts` and
 * `plugin/storage-gcs.emulator.test.ts`, both of which swap throwaway drivers
 * into the live registry for the duration of a test.
 *
 * The registration reaches into the registry's private `drivers` map on
 * purpose: the public `register()` guards against registering the same name
 * twice, which is exactly what a suite that re-registers per test needs to
 * bypass. Keeping that reflection in one place means a change to the map's
 * shape is a single edit rather than a hunt through every storage suite.
 */
export function registerFakeDriver(name: string, driver: StorageDriver): void {
  const reg = crowi.getPlugins().storage as unknown as { drivers: Map<string, { plugin: string; driver: StorageDriver }> };
  reg.drivers.set(name, { plugin: 'test', driver });
}

export function unregisterFakeDriver(name: string): void {
  const reg = crowi.getPlugins().storage as unknown as { drivers: Map<string, unknown> };
  reg.drivers.delete(name);
}

/** Seed a file (creating parent directories) under a `createLocalDriver` root. */
export function writeAt(root: string, relPath: string, body: string): void {
  const full = path.join(root, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, body);
}
