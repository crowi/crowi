import type { MigrationDefinition } from '../types';

/**
 * RFC-0008 §5.5 — the migration barrel.
 *
 * Every migration module under `packages/api/src/migration/migrations/`
 * exports a `MigrationDefinition` (built with `defineMigration`). They are
 * collected here into a flat array that `registry.ts` reads at startup,
 * then orders by version range + `order`.
 *
 * Phase 1 ships the framework core with **zero** registered migrations —
 * the runner / registry / boot wiring must all work against an empty
 * registry. Subsequent phases append their definitions here:
 *
 *   import { pageStatusDefault } from './page-status-default';   // phase 2 (boot)
 *   import { wikilinkFormat } from './wikilink-format';          // phase 3 (preflight)
 *   import { userUniquePrepare } from './user-unique-prepare';   // phase 5 (preflight)
 *   import { revisionsSchemaUnify } from './revisions-schema-unify'; // phase 6 (preflight)
 */
export const allMigrations: MigrationDefinition[] = [];
