import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Schema for the project-level `crowi.config.json` that ships with a
 * `crowi-admin init` workspace. Validated at boot. Plugin authors edit
 * this via `crowi-admin plugin add/remove`; operators may also hand-edit.
 *
 * Plugin-specific *configuration values* (S3 bucket, OAuth client_id,
 * etc.) live in the Mongo Config collection under `plugin:<name>:*`,
 * not in this file. This file only declares which plugins to load and
 * which driver from each registry to use.
 */
export const CrowiConfigFileSchema = z.object({
  /**
   * Names of plugins to load at boot, in addition to the implicit
   * defaults (`@crowi/plugin-storage-local`, `@crowi/plugin-search-mongo`).
   * Names must resolve via the project's `node_modules/`.
   */
  plugins: z.array(z.string()).default([]),

  storage: z
    .object({
      /**
       * Driver name (registered by some plugin) the file uploader
       * service should use. Defaults to `'local'` (provided by the
       * default-on `@crowi/plugin-storage-local` plugin).
       */
      driver: z.string().default('local'),
    })
    .default({ driver: 'local' }),

  search: z
    .object({
      /**
       * Driver name the search service should use. Defaults to
       * `'mongo'` (provided by the default-on `@crowi/plugin-search-mongo`).
       */
      driver: z.string().default('mongo'),
    })
    .default({ driver: 'mongo' }),
});

export type CrowiConfigFile = z.infer<typeof CrowiConfigFileSchema>;

/**
 * Plugins that are loaded *implicitly* on every boot, prepended to
 * whatever the user's config file lists. They cover the always-on
 * default drivers (local file storage, Mongo regex search) so a
 * fresh install starts up as a working Wiki without any additional
 * plugin install.
 *
 * `@crowi/plugin-search-mongo` is added in a follow-up step.
 */
export const IMPLICIT_DEFAULT_PLUGINS: readonly string[] = ['@crowi/plugin-storage-local'];

/**
 * Read and validate `crowi.config.json` from the given project
 * directory (or the current working directory by default). When the
 * file is absent, returns the schema's defaults so a freshly-cloned
 * project still boots.
 */
export async function loadCrowiConfigFile(projectDir: string = process.cwd()): Promise<CrowiConfigFile> {
  const filepath = path.join(projectDir, 'crowi.config.json');

  let raw: string;
  try {
    raw = await fs.readFile(filepath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return CrowiConfigFileSchema.parse({});
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`crowi.config.json: invalid JSON — ${(err as Error).message}`);
  }

  const result = CrowiConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`crowi.config.json: schema validation failed — ${result.error.message}`);
  }
  return result.data;
}

/**
 * Resolve the final ordered list of plugin names to load for a given
 * config: `[...IMPLICIT_DEFAULTS, ...config.plugins]` deduplicated
 * preserving first-occurrence order.
 */
export function resolvePluginList(config: CrowiConfigFile): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const name of [...IMPLICIT_DEFAULT_PLUGINS, ...config.plugins]) {
    if (seen.has(name)) continue;
    seen.add(name);
    ordered.push(name);
  }
  return ordered;
}
