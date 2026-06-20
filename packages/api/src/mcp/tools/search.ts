/**
 * RFC-0011 §8 — search tool catalog.
 *
 * `crowi_search_pages` dispatches to `GET /search` and returns a compact
 * `path — snippet` summary as text plus the full hit array as
 * `structuredContent` (RFC-0011 §9).
 */
import { SearchPagesRequestSchema } from '@crowi/api-contract';
import { generateNonce, okResult, wrapUntrusted } from '../result';
import type { ToolDescriptor } from '../server';

type Json = Record<string, unknown>;

/**
 * RFC-0011 §10.7 — a search snippet is a body excerpt = user-generated and
 * untrusted, so it carries the same injection risk as a full page body. The
 * path / count / pager around it are server-generated metadata and stay
 * plain. We fence the snippets (not the whole line) so a single
 * `wrapUntrusted` notice + nonce covers every snippet in the response while
 * the structural `- <path>` scaffolding the model needs to act on stays
 * outside the data region. The `structuredContent.data` array is left raw but
 * flagged `trust: 'untrusted'` (parallel to `okResultWithBody`'s raw +
 * flagged `structuredContent.body`).
 */
export const mapSearchResult = (body: unknown) => {
  const env = body as { data?: Array<Json>; meta?: Json };
  const data = env.data ?? [];
  // One nonce per response (see okResultWithBody): an attacker cannot guess
  // it, so a forged close tag inside a snippet cannot break out of its fence.
  const nonce = generateNonce();
  const lines = data.map((hit) => {
    const line = `- ${String(hit.path)}`;
    const snippet = typeof hit.snippet === 'string' ? hit.snippet.replace(/\s+/g, ' ').trim() : '';
    return snippet ? `${line} — ${wrapUntrusted(snippet, nonce)}` : line;
  });
  const total = (env.meta as { total?: number } | undefined)?.total ?? data.length;
  const text = data.length ? `${total} match(es) (showing ${data.length}):\n${lines.join('\n')}` : 'No matching pages.';
  return okResult(text, { data, trust: 'untrusted', meta: env.meta });
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
