import { ListPageChildrenRequestSchema } from '@crowi/api-contract';
import type { Command } from 'commander';

import { authedFetch, CliError, EXIT } from '../lib/http';
import { render } from '../lib/output';
import { requireProfile } from './_shared';

/**
 * The `GET /api/v2/pages/children` response (ListPageChildrenResponseSchema).
 * Parsed leniently — only the fields the CLI renders are declared.
 */
interface ListChildrenResponse {
  children?: Array<{
    segment?: string;
    path?: string;
    isPage?: boolean;
    hasPortal?: boolean;
    count?: number;
  }>;
}

/**
 * `crowi ls [path]` — list the immediate child pages/segments under a
 * portal path via `GET /api/v2/pages/children` (`pages:read`, in the
 * default login scope). Defaults to `/` (top level). Prints one path per
 * row (trailing slash for directories/portals); `--json` emits the raw
 * response.
 */
export function registerLs(program: Command): void {
  program
    .command('ls [path]')
    .description('List child pages under a path (defaults to the top level)')
    .action(async (path: string | undefined, _options: unknown, command: Command) => {
      const { profile, globals } = requireProfile(command);

      // Default to the top level; add a leading slash to bare paths.
      const raw = path ?? '/';
      const normalised = raw.startsWith('/') ? raw : `/${raw}`;

      const parsed = ListPageChildrenRequestSchema.safeParse({ path: normalised });
      if (!parsed.success) {
        throw new CliError(`invalid path: ${parsed.error.issues.map((i) => i.message).join('; ')}`, {
          exitCode: EXIT.INVALID,
        });
      }

      const body = await authedFetch<ListChildrenResponse>(profile, 'GET', '/pages/children', {
        query: parsed.data,
      });

      const children = body.children ?? [];
      render(
        body,
        () => {
          if (children.length === 0) {
            return '(no child pages)';
          }
          return children
            .map((child) => {
              // Directories / portals keep their trailing slash; a leaf
              // page is shown at its non-slashed path.
              const isDir = child.hasPortal || (child.count ?? 0) > 0;
              const display = child.path ?? child.segment ?? '(unknown)';
              if (isDir && !display.endsWith('/')) {
                return `${display}/`;
              }
              if (!isDir && child.isPage) {
                return display.replace(/\/$/, '');
              }
              return display;
            })
            .join('\n');
        },
        globals,
      );
    });
}
