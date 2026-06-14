import { SearchPagesRequestSchema } from '@crowi/api-contract';
import type { Command } from 'commander';

import { authedFetch, CliError, EXIT } from '../lib/http';
import { render } from '../lib/output';
import { requireProfile } from './_shared';

/**
 * The `GET /api/v2/search` response (SearchPagesResponseSchema). Parsed
 * leniently — only the fields the CLI renders are declared; extra/missing
 * fields are tolerated for version-skew across self-hosted servers.
 */
interface SearchResponse {
  meta?: { total?: number; results?: number; took?: number };
  data?: Array<{
    path?: string;
    score?: number;
    snippet?: string;
    pageId?: string;
  }>;
}

/**
 * Collapse a driver-supplied highlight snippet into a single-line preview:
 * strip `<mark>` (and any other) HTML tags and flatten whitespace so the
 * "path — snippet" row stays on one line.
 */
function flattenSnippet(snippet: string): string {
  return snippet
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * `crowi search <query>` — full-text search via `GET /api/v2/search`
 * (`pages:read`, in the default login scope). Prints one `path — snippet`
 * row per hit; `--json` emits the raw response. When the server has no
 * search plugin active the endpoint returns 503, surfaced as a clear
 * "search is disabled on this server" message.
 */
export function registerSearch(program: Command): void {
  program
    .command('search <query>')
    .description('Search pages by full-text query')
    .option('--tree <path>', 'restrict to a path prefix (e.g. /team/eng/)')
    .option('--type <type>', 'page type filter: portal | public | user')
    .option('--page <n>', 'result page number (1-based)')
    .option('--limit <n>', 'max results per page (default 50, max 100)')
    .action(async (query: string, options: { tree?: string; type?: string; page?: string; limit?: string }, command: Command) => {
      const { profile, globals } = requireProfile(command);

      // Validate outgoing args against the v2 request floor before any
      // round-trip, so a bad --type / --limit fails locally and clearly.
      const parsed = SearchPagesRequestSchema.safeParse({
        q: query,
        tree: options.tree,
        type: options.type,
        page: options.page,
        limit: options.limit,
      });
      if (!parsed.success) {
        throw new CliError(`invalid search arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}`, {
          exitCode: EXIT.INVALID,
        });
      }

      const { q, tree, type, page, limit } = parsed.data;
      let body: SearchResponse;
      try {
        body = await authedFetch<SearchResponse>(profile, 'GET', '/search', {
          query: { q, tree, type, page, limit },
        });
      } catch (err) {
        // The search endpoint returns 503 when no search plugin is active.
        if (err instanceof CliError && err.status === 503) {
          throw new CliError('search is disabled on this server (no search backend configured)', {
            exitCode: EXIT.UNAVAILABLE,
          });
        }
        throw err;
      }

      const hits = body.data ?? [];
      render(
        body,
        () => {
          if (hits.length === 0) {
            return 'No results.';
          }
          return hits
            .map((hit) => {
              const path = hit.path ?? hit.pageId ?? '(unknown)';
              const snippet = hit.snippet ? flattenSnippet(hit.snippet) : '';
              return snippet ? `${path} — ${snippet}` : path;
            })
            .join('\n');
        },
        globals,
      );
    });
}
