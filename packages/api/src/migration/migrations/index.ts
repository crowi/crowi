import type { MigrationDefinition } from '../types';
import { collabLifecycleVersion } from './collab-lifecycle-version';
import { filesUrlToAttachments } from './files-url-to-attachments';
import { pageStatusDefault } from './page-status-default';
import { relocateReservedApiPaths } from './relocate-reserved-api-paths';
import { revisionsSchemaUnify } from './revisions-schema-unify';
import { userUniquePrepare } from './user-unique-prepare';
import { wikilinkFormat } from './wikilink-format';
import { wikilinkHtmlRecover } from './wikilink-html-recover';

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
  filesUrlToAttachments, // feature-migration-files-url-rewrite (preflight) — v1 /files/<id> body rewrite (independent regex from wikilink-format/html-tag-fixes)
  wikilinkHtmlRecover, // migration-html-tag-fixes (preflight) — recover </font> etc. corrupted by wikilink-format
  collabLifecycleVersion, // feature-collab-invalidate-on-rename-delete (boot) — RFC-0017 Phase 1 backfill
];
