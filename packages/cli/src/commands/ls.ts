import { ListPageChildrenRequestSchema } from '@crowi/api-contract';
import type { Command } from 'commander';

import { renderRecords, resolveFormat } from '../lib/format';
import { authedFetch, CliError, EXIT } from '../lib/http';
import { requireProfile } from './_shared';

/** One child segment in the `GET /api/v2/pages/children` response. */
interface ChildSegment {
  segment?: string;
  path?: string;
  isPage?: boolean;
  hasPortal?: boolean;
  count?: number;
}

/**
 * The `GET /api/v2/pages/children` response (ListPageChildrenResponseSchema).
 * Parsed leniently — only the fields the CLI renders are declared.
 */
interface ListChildrenResponse {
  children?: ChildSegment[];
}

/** Format one child segment as a human row (dir → trailing slash). */
function childHumanLine(child: ChildSegment): string {
  const isDir = child.hasPortal || (child.count ?? 0) > 0;
  const display = child.path ?? child.segment ?? '(unknown)';
  if (isDir && !display.endsWith('/')) {
    return `${display}/`;
  }
  if (!isDir && child.isPage) {
    return display.replace(/\/$/, '');
  }
  return display;
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
    .option('--format <mode>', 'output format: human | table | template | json')
    .option('--template <tpl>', "row template with {{field}} placeholders, e.g. '{{path}}\\t{{count}}'")
    .action(async (path: string | undefined, options: { format?: string; template?: string }, command: Command) => {
      const { profile, globals } = requireProfile(command);
      const mode = resolveFormat({ format: options.format, template: options.template, json: globals.json });

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
      renderRecords(body, children, mode, {
        template: options.template,
        columns: ['path', 'isPage', 'hasPortal', 'count'],
        emptyHuman: '(no child pages)',
        humanLine: (record) => childHumanLine(record as ChildSegment),
      });
    });
}
