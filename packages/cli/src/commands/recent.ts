import { LIST_PAGES_PREFIX_LIMIT, LIST_PAGES_PREFIX_OFFSET, type ListPagesResponse, type PageListRow } from '@crowi/api-contract';
import type { Command } from 'commander';

import { getGlobalOptions } from '../cli';
import { maybeWarnVersionSkew } from '../lib/capability';
import { applyTemplate, renderRecords, resolveFormat } from '../lib/format';
import { authedFetch, CliError, EXIT } from '../lib/http';
import { normalisePath } from '../lib/page-ref';
import { markNoSkewProbe } from '../lib/skew';
import { requireProfile } from './_shared';

interface RecentOptions {
  prefix?: string;
  limit?: string;
  offset?: string;
  format?: string;
  template?: string;
}

/** Only the fields the CLI renders; everything else is read leniently. */
type RecentPage = Partial<Pick<PageListRow, '_id' | 'path' | 'updatedAt' | 'lastUpdateUser'>>;

type RecentResponse = Omit<Partial<ListPagesResponse>, 'pages'> & { pages?: RecentPage[] };

interface RecentDisplayRow {
  path: string;
  updatedAt: string;
  lastUpdateUser: string;
  _id: string;
}

const LIMIT_RANGE = { ...LIST_PAGES_PREFIX_LIMIT, default: 50 } as const;
const OFFSET_RANGE = { ...LIST_PAGES_PREFIX_OFFSET, default: 0 } as const;
const HUMAN_TEMPLATE = '{{path}}\t{{updatedAt}}\t{{lastUpdateUser}}\t{{_id}}';

function parseRecentInteger(value: string | undefined, flag: 'limit' | 'offset'): number {
  const range = flag === 'limit' ? LIMIT_RANGE : OFFSET_RANGE;
  if (value === undefined) {
    return range.default;
  }
  const parsed = /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < range.min || parsed > range.max) {
    throw new CliError(`--${flag} must be an integer between ${range.min} and ${range.max}`, { exitCode: EXIT.INVALID });
  }
  return parsed;
}

/** `undefined` means "no prefix filter" (flag omitted, or it names the root). */
function normalizeRecentPrefix(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === '') {
    throw new CliError('--prefix must not be empty', { exitCode: EXIT.INVALID });
  }
  const withSlash = normalisePath(value);
  return withSlash === '/' ? undefined : withSlash;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function recentDisplayRow(page: RecentPage): RecentDisplayRow {
  const updatedAtRaw: unknown = page.updatedAt;
  const updatedAtMs = typeof updatedAtRaw === 'string' ? Date.parse(updatedAtRaw) : Number.NaN;

  const updater: unknown = page.lastUpdateUser;
  let updaterName = '';
  if (typeof updater === 'string') {
    updaterName = updater;
  } else if (updater !== null && typeof updater === 'object') {
    const record = updater as Record<string, unknown>;
    updaterName = nonEmptyString(record.username) ?? nonEmptyString(record.name) ?? nonEmptyString(record._id) ?? '';
  }

  return {
    path: typeof page.path === 'string' ? page.path : '',
    updatedAt: Number.isNaN(updatedAtMs) ? '' : new Date(updatedAtMs).toISOString(),
    lastUpdateUser: updaterName,
    _id: typeof page._id === 'string' ? page._id : '',
  };
}

function recentHumanLine(record: unknown): string {
  return applyTemplate(HUMAN_TEMPLATE, recentDisplayRow(record as RecentPage));
}

/**
 * `crowi recent` — pages the viewer can read, newest update first, via
 * `GET /api/pages/list` (`pages:read`). A flat list of current page state,
 * not an event log.
 */
export function registerRecent(program: Command): void {
  // Validation must reject bad input before any network traffic, including
  // the shared version probe, so this command opts out of the global
  // `preSubcommand` probe and runs it itself once the arguments are valid.
  const command = markNoSkewProbe(program.command('recent'));
  command
    .description('List recently updated pages, newest first (all readable pages)')
    .allowExcessArguments(false)
    .option('--prefix <path>', 'only pages whose path literally starts with <path> (e.g. /team/ or /team); needs a server that supports it')
    .option('--limit <n>', 'max rows (1-100, default 50)')
    .option('--offset <n>', 'rows to skip (0-2147483647, default 0)')
    .option('--format <mode>', 'output format: human | table | template | json')
    .option('--template <tpl>', "row template with {{field}} placeholders, e.g. '{{path}}\\t{{updatedAt}}'")
    .addHelpText(
      'after',
      `
Columns: path, updatedAt (UTC), lastUpdateUser (last updater, not the creator), _id.
Rows do not include the page body (revision.body is empty in templates and absent in --format json); fetch a page to read its body.
This is the live list of current pages, one row per page. Paging with --offset can repeat or skip pages that were updated between calls, and rows with the same update time have no defined order.

Examples:
  crowi recent
  crowi recent --limit 20 --json
  crowi recent --prefix /team/ --limit 20 --offset 20
  crowi recent --prefix /team --format table
  crowi recent --template '{{path}}\\t{{updatedAt}}\\t{{lastUpdateUser.username}}\\t{{_id}}'`,
    )
    .action(async (options: RecentOptions, cmd: Command) => {
      const limit = parseRecentInteger(options.limit, 'limit');
      const offset = parseRecentInteger(options.offset, 'offset');
      const prefix = normalizeRecentPrefix(options.prefix);
      const mode = resolveFormat({ format: options.format, template: options.template, json: getGlobalOptions(cmd).json });

      const { profile, globals } = requireProfile(cmd);
      await maybeWarnVersionSkew({ profile: globals.profile, url: globals.url, token: globals.token });

      const body = await authedFetch<RecentResponse>(profile, 'GET', '/pages/list', {
        query: { limit, offset, sort: 'updatedAt', order: 'desc', path_prefix: prefix },
      });

      if (prefix !== undefined && body?.appliedPathPrefix !== prefix) {
        throw new CliError('server did not confirm literal prefix filtering; upgrade Crowi and retry', { exitCode: EXIT.UNAVAILABLE });
      }

      const pages = body?.pages ?? [];
      if (!Array.isArray(pages)) {
        throw new CliError('unexpected response from server: "pages" is not a list');
      }
      if (pages.some((page) => page === null || typeof page !== 'object')) {
        throw new CliError('unexpected response from server: "pages" contains a non-object row');
      }

      const columns = ['path', 'updatedAt', 'lastUpdateUser', '_id'];
      renderRecords(body, mode === 'table' ? pages.map(recentDisplayRow) : pages, mode, {
        template: options.template,
        columns,
        emptyHuman: '(no recently updated pages)',
        humanLine: recentHumanLine,
      });
    });
}
