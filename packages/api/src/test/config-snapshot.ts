/**
 * Shared test helper for the process-wide `crowi` Config singleton.
 *
 * Several auth-adjacent handler suites (`me`, `tokenAuth`, `user`,
 * `access-token`, `oauth`, ...) wipe the whole `ns: 'crowi'` config namespace
 * in `beforeAll` and re-seed it via `applicationInstall()` so the install
 * marker + security/auth/registration defaults exist for their flow. The
 * matching `afterAll` historically wiped the namespace again and only called
 * `load()` — leaving the shared config EMPTY for whatever test file the worker
 * runs next. When suites share the test database under parallel jest workers,
 * another worker's authenticated request can land while the namespace is empty
 * and read back missing auth/registration/security config → spurious 401
 * ("single-file green, full-suite seed-401 flake").
 *
 * These helpers snapshot the `ns: 'crowi'` rows verbatim (raw, possibly
 * encrypted `value` strings) before a suite mutates them, and restore that
 * exact set afterwards — returning the shared config to its as-discovered
 * (installed + seeded) state. Mirrors the snapshot/restore pattern already
 * applied to the `crowi` singleton in `crowi/index.test.ts`.
 */
import type Crowi from 'src/crowi';

export interface ConfigRow {
  ns: string;
  key: string;
  value: string;
}

/**
 * Read every `ns: 'crowi'` config row as a plain `{ ns, key, value }` object,
 * preserving the stored (possibly encrypted) `value` verbatim so a later
 * restore is byte-identical.
 */
export async function snapshotCrowiConfig(crowi: Crowi): Promise<ConfigRow[]> {
  const Config = crowi.model('Config');
  const rows = (await Config.find({ ns: 'crowi' }).lean().exec()) as ConfigRow[];
  return rows.map(({ ns, key, value }) => ({ ns, key, value }));
}

/**
 * Restore the `ns: 'crowi'` namespace to a previously captured snapshot:
 * drop the current rows, re-insert the snapshot verbatim, then reload the
 * in-memory config cache so `crowi.getConfig()` reflects the restored state.
 */
export async function restoreCrowiConfig(crowi: Crowi, snapshot: ConfigRow[]): Promise<void> {
  const Config = crowi.model('Config');
  await Config.deleteMany({ ns: 'crowi' });
  if (snapshot.length > 0) {
    await Config.insertMany(snapshot.map(({ ns, key, value }) => ({ ns, key, value })));
  }
  await crowi.getConfigService().load();
}
