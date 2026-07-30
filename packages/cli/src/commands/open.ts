import type { Command } from 'commander';

import { openBrowser } from '../lib/browser';
import { stripTrailingSlash } from '../lib/config';
import { render } from '../lib/output';
import { isObjectId, normalisePath } from '../lib/page-ref';
import { markNoSkewProbe } from '../lib/skew';
import { requireProfile } from './_shared';

/**
 * Build the web URL for a `<path-or-id>` against a server endpoint. A bare
 * 24-hex ObjectId resolves through the server's `/<page_id>` short link;
 * everything else is treated as a leading-slash page path. No `/api`
 * prefix — this is the human-facing web origin.
 */
function pageUrl(endpoint: string, pathOrId: string): string {
  const base = stripTrailingSlash(endpoint);
  if (isObjectId(pathOrId)) {
    return `${base}/${pathOrId}`;
  }
  return `${base}${normalisePath(pathOrId)}`;
}

/**
 * `crowi open <path-or-id>` — open a page in the system browser. No API call
 * is needed (the URL is derived locally); on a headless host where the
 * browser cannot be launched, the URL is printed instead so the user can copy
 * it. `--json` (or `--print`) emits the URL without launching.
 */
export function registerOpen(program: Command): void {
  const cmd = program
    .command('open <path-or-id>')
    .description('Open a page in the system browser')
    .option('--print', 'print the page URL instead of launching the browser')
    .action(async (pathOrId: string, options: { print?: boolean }, command: Command) => {
      const { profile, globals } = requireProfile(command);
      const url = pageUrl(profile.endpoint, pathOrId);

      // --print / --json: just emit the URL.
      if (options.print || globals.json) {
        render({ url }, () => url, globals);
        return;
      }

      const launched = await openBrowser(url);
      if (launched) {
        render({ url }, () => `Opening ${url}`, globals);
      } else {
        // Headless / no browser: surface the URL so it is still useful.
        render({ url }, () => url, globals);
      }
    });
  // Local-only: the URL is derived without an API call.
  markNoSkewProbe(cmd);
}
