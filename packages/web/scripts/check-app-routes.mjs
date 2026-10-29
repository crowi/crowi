// Runs after `next build`: fails the build when a route that only exists
// because of its on-disk spelling is missing from the production manifest.
// `/(auth)/%5Fr/[id]` serves the legacy `/_r/<id>` alias; a literal `_r`
// directory is private to the App Router and silently builds nothing, so the
// manifest entry is the only direct evidence the alias is reachable. The check
// lives here rather than in a test because a component test cannot build the
// app within its timeout, and a dev server's manifest lists only visited routes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_ROUTES = ['/(auth)/_r/[id]/page'];

const packageDir = fileURLToPath(new URL('../', import.meta.url));
const manifestPath = path.resolve(packageDir, process.env.NEXT_DIST_DIR || '.next', 'server/app-paths-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

for (const route of REQUIRED_ROUTES) {
  assert.equal(typeof manifest[route], 'string', `Missing production route ${route} in ${manifestPath}`);
}
