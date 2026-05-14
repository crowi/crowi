import path from 'node:path';

/**
 * Resolve a file inside `@crowi/api/dist/...` without triggering the
 * api package's default export (`dist/app.js`), which would auto-boot
 * the Express server. Collab is a separate Node process — it shares
 * Mongoose model factories + JWT utils with api but must never invoke
 * the HTTP server boot.
 *
 * The lookup mirrors the admin-cli pattern (`packages/admin-cli/src/
 * commands/storage-copy.ts`): search from `process.cwd()` (the runner
 * directory in prod, repo root in dev) then this module's `__dirname`
 * so the workspace symlink also resolves during tests invoked from
 * `packages/collab`.
 *
 * Phase 4 / 5 may add `exports` to `@crowi/api/package.json` for
 * cleaner subpath imports; this helper is the single source of truth
 * for the `dist/` assumption so swapping is a one-file change.
 */
export function resolveApiDistFile(relPath: string): string {
  const apiPkgPath = require.resolve('@crowi/api/package.json', { paths: [process.cwd(), __dirname] });
  return path.join(path.dirname(apiPkgPath), 'dist', relPath);
}
