import type { MigrationDefinition } from '../types';
import { pageStatusDefault } from './page-status-default';

/**
 * RFC-0008 §5.5 — the migration barrel.
 *
 * Every migration module under `packages/api/src/migration/migrations/`
 * exports a `MigrationDefinition` (built with `defineMigration`). They are
 * collected here into a flat array that `registry.ts` reads at startup,
 * then orders by version range + `order`.
 *
 * Subsequent phases append their definitions here:
 *
 *   import { wikilinkFormat } from './wikilink-format';          // phase 3 (preflight)
 *   import { userUniquePrepare } from './user-unique-prepare';   // phase 5 (preflight)
 *   import { revisionsSchemaUnify } from './revisions-schema-unify'; // phase 6 (preflight)
 */
export const allMigrations: MigrationDefinition[] = [
  pageStatusDefault, // phase 2 (boot)
];
