/**
 * RFC-0011 §8 — page tool catalog (read 7 + write 5).
 *
 * Each tool is a data-driven `ToolDescriptor`: its `schema` reuses the
 * `@crowi/api-contract` Zod schema's `.shape` for boundary validation
 * (RFC-0011 §6), `method` + `path` name the in-process route it
 * dispatches to (bare path, no `/api/v2`), and `resultMapper` turns the
 * route's JSON envelope into an MCP tool result (RFC-0011 §9).
 *
 * Schema notes (architecturalNotes "ズレ表"):
 *  - `crowi_get_page_history` dispatches to `/pages/{page_id}/revisions`.
 *    `ListRevisionsRequestSchema` only carries `{ limit, offset }`, so we
 *    compose a `page_id` field into the tool schema; the server splices
 *    it into the path and the rest becomes the query.
 *  - `crowi_get_revision` dispatches to `/pages/revisions/{id}`. The
 *    route has no named request schema (only the `id` path param), so the
 *    tool defines a thin `{ id }` shape locally.
 *  - `crowi_delete_page` / `crowi_revert_page` reuse the body schemas that
 *    `contracts/page.ts` keeps local (not exported from `schemas/`). To
 *    avoid widening the contract surface (which would force an
 *    api-contract rebuild + OpenAPI regen), the MCP layer defines the same
 *    shapes here rather than exporting them — they are a thin, stable
 *    `{ page_id, … }`.
 *  - `crowi_update_page`: `UpdatePageRequestSchema.revision_id` is
 *    optional in the contract; the optimistic-lock 409 is enforced by the
 *    handler. The tool description strongly requires it (fetch → update),
 *    but the schema is left as-is (not forced required) so the contract is
 *    the single source of truth and a model that omits it gets the
 *    handler's 409 rather than a divergent MCP-only validation error.
 */
import {
  AutocompleteRequestSchema,
  CreatePageRequestSchema,
  GetBacklinksRequestSchema,
  GetPageRequestSchema,
  ListPageChildrenRequestSchema,
  ListPagesRequestSchema,
  ListRevisionsRequestSchema,
  RenamePageRequestSchema,
  UpdatePageRequestSchema,
} from '@crowi/api-contract';
import { z } from 'zod';

import type { ToolDescriptor } from '../server';
import { okResult } from '../result';

// --- local shapes for routes without an exported named request schema ---

/** `crowi_get_page_history` — `page_id` (path) + list query. */
const GetPageHistoryShape = {
  page_id: z.string().describe('The page id whose revision history to list.'),
  ...ListRevisionsRequestSchema.shape,
};

/** `crowi_get_revision` — single revision by id (the route's `{id}` param). */
const GetRevisionShape = {
  id: z.string().describe('The revision id to fetch (the `revision._id`).'),
};

/** `crowi_delete_page` — same shape as `contracts/page.ts` DeletePageRequestSchema. */
const DeletePageShape = {
  page_id: z.string().describe('The page id to delete.'),
  revision_id: z
    .string()
    .optional()
    .describe('Latest known revision id for optimistic-lock; recommended to avoid deleting a page edited since you last read it.'),
  completely: z.boolean().optional().describe('When true, hard-delete (skip trash). Defaults to a soft delete into /trash.'),
};

/** `crowi_revert_page` — restore a soft-deleted page from trash. */
const RevertPageShape = {
  page_id: z.string().describe('The id of the soft-deleted (trash) page to restore.'),
};

// --- result mappers (RFC-0011 §9) ----------------------------------------

type Json = Record<string, unknown>;

/** Pull the revision body + structured meta from a `{ page }` envelope. */
const mapPageResult = (body: unknown) => {
  const page = (body as { page?: Json }).page ?? {};
  const revision = (page.revision as Json | undefined) ?? {};
  const text = typeof revision.body === 'string' ? revision.body : JSON.stringify(page, null, 2);
  return okResult(text, {
    path: page.path,
    page_id: page._id,
    revision_id: revision._id,
    grant: page.grant,
    updatedAt: page.updatedAt,
  });
};

/** `{ revision }` single revision body. */
const mapRevisionResult = (body: unknown) => {
  const revision = (body as { revision?: Json }).revision ?? {};
  const text = typeof revision.body === 'string' ? revision.body : JSON.stringify(revision, null, 2);
  return okResult(text, { revision_id: revision._id, path: revision.path, createdAt: revision.createdAt });
};

/**
 * Build a list result mapper: extract `field` from the envelope, render a
 * compact `count noun(s):` text summary (one `formatLine` per item, or
 * `empty` when none), and echo the full array plus any `extra` structured
 * fields. All the `{ pages } / { children } / { revisions } / …` listings
 * share this shape (RFC-0011 §9), so each is one config row, not a copy.
 */
const listMapper =
  (opts: { field: string; noun: string; empty: string; formatLine: (item: Json) => string; extra?: (env: Json) => Json }) => (body: unknown) => {
    const env = (body as Json) ?? {};
    const items = (env[opts.field] as Array<Json> | undefined) ?? [];
    const lines = items.map(opts.formatLine);
    const text = items.length ? `${items.length} ${opts.noun}(s):\n${lines.join('\n')}` : opts.empty;
    return okResult(text, { [opts.field]: items, ...(opts.extra?.(env) ?? {}) });
  };

/** Compact `path` list + full array for `{ pages }` listings. */
const mapPageListResult = listMapper({
  field: 'pages',
  noun: 'page',
  empty: 'No pages found.',
  formatLine: (p) => `- ${String(p.path)}`,
  extra: (env) => ({ pager: env.pager }),
});

/** `{ children }` segment list. */
const mapChildrenResult = listMapper({
  field: 'children',
  noun: 'child segment',
  empty: 'No child pages.',
  formatLine: (c) => `- ${String(c.path)}${c.isPage ? '' : ' (directory)'}`,
});

/** `{ revisions, pager }` history. */
const mapRevisionListResult = listMapper({
  field: 'revisions',
  noun: 'revision',
  empty: 'No revisions.',
  formatLine: (r) => `- ${String(r._id)} @ ${String(r.createdAt)}`,
  extra: (env) => ({ pager: env.pager }),
});

/** `{ backlinks, hasNext }`. */
const mapBacklinksResult = listMapper({
  field: 'backlinks',
  noun: 'backlink',
  empty: 'No backlinks.',
  formatLine: (b) => `- ${String((b.fromPage as Json | undefined)?.path ?? b._id)}`,
  extra: (env) => ({ hasNext: env.hasNext }),
});

/** `{ results }` autocomplete candidates. */
const mapAutocompleteResult = listMapper({
  field: 'results',
  noun: 'suggestion',
  empty: 'No suggestions.',
  formatLine: (r) => `- ${String(r.label)}`,
});

// --- the table -----------------------------------------------------------

export const pageTools: ToolDescriptor[] = [
  // ---------------------------------------------------------------- reads
  {
    name: 'crowi_get_page',
    description:
      'Read a wiki page (markdown body + metadata) by `path` or `page_id`. Returns the page body as text. Read this before updating a page so you have its current `revision_id`.',
    method: 'GET',
    path: '/pages',
    schema: GetPageRequestSchema.shape,
    kind: 'query',
    scope: 'pages:read',
    resultMapper: mapPageResult,
  },
  {
    name: 'crowi_list_pages',
    description: 'List wiki pages under a `path` or created by a `user`, paginated. Returns page paths and metadata, not bodies.',
    method: 'GET',
    path: '/pages/list',
    schema: ListPagesRequestSchema.shape,
    kind: 'query',
    scope: 'pages:read',
    resultMapper: mapPageListResult,
  },
  {
    name: 'crowi_list_child_pages',
    description: 'List the immediate child segments directly under a portal `path` (sidebar/tree navigation). Use `/` to list the top-level segments.',
    method: 'GET',
    path: '/pages/children',
    schema: ListPageChildrenRequestSchema.shape,
    kind: 'query',
    scope: 'pages:read',
    resultMapper: mapChildrenResult,
  },
  {
    name: 'crowi_get_page_history',
    description: "List a page's revision history (newest first), metadata only. Pass `page_id`; use `crowi_get_revision` to fetch a specific revision's body.",
    method: 'GET',
    path: '/pages/{page_id}/revisions',
    schema: GetPageHistoryShape,
    kind: 'query',
    scope: 'pages:read',
    resultMapper: mapRevisionListResult,
  },
  {
    name: 'crowi_get_revision',
    description: "Fetch a single revision's full markdown body by revision `id`.",
    method: 'GET',
    path: '/pages/revisions/{id}',
    schema: GetRevisionShape,
    kind: 'query',
    scope: 'pages:read',
    resultMapper: mapRevisionResult,
  },
  {
    name: 'crowi_get_backlinks',
    description: 'List pages that link to the given page (`page_id`), paginated.',
    method: 'GET',
    path: '/backlinks',
    schema: GetBacklinksRequestSchema.shape,
    kind: 'query',
    scope: 'pages:read',
    resultMapper: mapBacklinksResult,
  },
  {
    name: 'crowi_autocomplete_pages',
    description: 'Suggest page paths matching a partial query `q` (path completion). Use to discover exact page paths before reading.',
    method: 'GET',
    path: '/pages/autocomplete',
    schema: AutocompleteRequestSchema.shape,
    kind: 'query',
    scope: 'pages:read',
    resultMapper: mapAutocompleteResult,
  },
  // --------------------------------------------------------------- writes
  {
    name: 'crowi_create_page',
    description: 'Create a new wiki page at `path` with markdown `body` (optional `grant` visibility). Fails if a page already exists at `path`.',
    method: 'POST',
    path: '/pages',
    schema: CreatePageRequestSchema.shape,
    kind: 'body',
    scope: 'pages:write',
    resultMapper: mapPageResult,
  },
  {
    name: 'crowi_update_page',
    description:
      "Update a page (`page_id`) with new markdown `body`. ALWAYS pass `revision_id` (the page's current revision, from `crowi_get_page`) for optimistic locking — a stale `revision_id` returns a 409 conflict and you must re-fetch the page and retry. The returned `revision_id` is the new one for chaining edits.",
    method: 'PUT',
    path: '/pages',
    schema: UpdatePageRequestSchema.shape,
    kind: 'body',
    scope: 'pages:write',
    resultMapper: mapPageResult,
  },
  {
    name: 'crowi_rename_page',
    description:
      'Rename/move a page (`page_id`) to `new_path`. Optionally pass `revision_id` (optimistic lock) and `create_redirect` to leave a redirect at the old path.',
    method: 'POST',
    path: '/pages/rename',
    schema: RenamePageRequestSchema.shape,
    kind: 'body',
    scope: 'pages:write',
    resultMapper: mapPageResult,
  },
  {
    name: 'crowi_delete_page',
    description:
      'Delete a page (`page_id`). By default a soft delete into /trash (recoverable via `crowi_revert_page`). Pass `completely: true` to hard-delete.',
    method: 'DELETE',
    path: '/pages',
    schema: DeletePageShape,
    kind: 'body',
    scope: 'pages:write',
    resultMapper: mapPageResult,
  },
  {
    name: 'crowi_revert_page',
    description: 'Restore a soft-deleted (trash) page back to its original path by `page_id`.',
    method: 'POST',
    path: '/pages/revert',
    schema: RevertPageShape,
    kind: 'body',
    scope: 'pages:write',
    resultMapper: mapPageResult,
  },
];
