import type { MigrationDefinition } from '../types';
import { pageStatusDefault } from './page-status-default';
import { relocateReservedApiPaths } from './relocate-reserved-api-paths';
import { revisionsSchemaUnify } from './revisions-schema-unify';
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
 * Every phase appends its definition here.
 */
export const allMigrations: MigrationDefinition[] = [
  pageStatusDefault, // phase 2 (boot)
  wikilinkFormat, // phase 3 (preflight)
  userUniquePrepare, // phase 5 (preflight)
  revisionsSchemaUnify, // phase 6 (boot — RFC-classified preflight, see migration JSDoc)
  relocateReservedApiPaths, // fix/mcp-endpoint (preflight) — v2 /api namespace reservation
];
