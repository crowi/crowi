import type { MigrationDefinition } from '../types';
import { pageStatusDefault } from './page-status-default';
import { userUniquePrepare } from './user-unique-prepare';
import { wikilinkFormat } from './wikilink-format';

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
 *   import { revisionsSchemaUnify } from './revisions-schema-unify'; // phase 6 (preflight)
 */
export const allMigrations: MigrationDefinition[] = [
  pageStatusDefault, // phase 2 (boot)
  wikilinkFormat, // phase 3 (preflight)
  userUniquePrepare, // phase 5 (preflight)
];
