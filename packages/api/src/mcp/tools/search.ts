/**
 * RFC-0011 §8 — search tool catalog.
 *
 * `crowi_search_pages` dispatches to `GET /search` and returns a compact
 * `path — snippet` summary as text plus the full hit array as
 * `structuredContent` (RFC-0011 §9).
 */
import { SearchPagesRequestSchema } from '@crowi/api-contract';

import type { ToolDescriptor } from '../server';
import { okResult } from '../result';

type Json = Record<string, unknown>;

const mapSearchResult = (body: unknown) => {
  const env = body as { data?: Array<Json>; meta?: Json };
  const data = env.data ?? [];
  const lines = data.map((hit) => {
    const snippet = typeof hit.snippet === 'string' ? ` — ${hit.snippet.replace(/\s+/g, ' ').trim()}` : '';
    return `- ${String(hit.path)}${snippet}`;
  });
  const total = (env.meta as { total?: number } | undefined)?.total ?? data.length;
  const text = data.length ? `${total} match(es) (showing ${data.length}):\n${lines.join('\n')}` : 'No matching pages.';
  return okResult(text, { data, meta: env.meta });
};

export const searchTools: ToolDescriptor[] = [
  {
    name: 'crowi_search_pages',
    description:
      'Full-text search the wiki for pages matching `q`. Optionally scope with `tree` (path prefix) or `type` (portal/public/user). Returns matching page paths with snippets.',
    method: 'GET',
    path: '/search',
    schema: SearchPagesRequestSchema.shape,
    kind: 'query',
    scope: 'pages:read',
    resultMapper: mapSearchResult,
  },
];
