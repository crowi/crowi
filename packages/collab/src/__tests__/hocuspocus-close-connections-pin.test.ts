import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * AC-36 — pin the installed `@hocuspocus/server` behaviour the AC-34
 * invalidator-drain fix (`invalidation.ts`) depends on.
 *
 * This package's Jest suite cannot `import`/`require` `@hocuspocus/server`
 * at runtime (its CJS bundle unconditionally `require`s `crossws/adapters/node`
 * at module top level, and `crossws` is ESM-only — see
 * `invalidation-lifecycle.test.ts`'s module doc comment for the same
 * documented constraint). So this test can't drive the REAL `Hocuspocus` /
 * `Document` / `Connection` classes directly the way it would for an
 * ordinary regression test. Instead it reads the INSTALLED package's
 * compiled source and asserts the two specific implementation details our
 * fix's correctness depends on are still present:
 *
 *   1. `Hocuspocus.prototype.closeConnections(documentName)` is REGISTRY
 *      lookup (`this.documents.forEach(...)`, scoped by `document.name`) —
 *      this is exactly why it silently closes NOTHING once
 *      `instance.documents.delete(documentName)` has already run (the
 *      state the invalidator's drain always finds itself in, since it
 *      detaches synchronously before the grace period). If a future
 *      `@hocuspocus/server` upgrade changed this to, say, an O(1) internal
 *      index keyed differently, or started throwing/no-op-ing when the doc
 *      is unregistered, `invalidation.ts`'s doc comment (which explains
 *      the bug in terms of THIS behaviour) would go stale — this test
 *      fails first.
 *   2. `Document.prototype.getConnections()` returns the connections
 *      attached to THAT document object (`Array.from(this.connections.keys())`),
 *      independent of the engine's `documents` registry. This is the
 *      surface our fix calls instead — closing each returned connection
 *      directly reaches a stale client regardless of whether its document
 *      is still registered under any name.
 *
 * A `pnpm update` / lockfile bump that changes either detail should fail
 * this test, prompting a review of `invalidation.ts` before it ships.
 */
describe('Hocuspocus 4 closeConnections/getConnections semantics (installed version pin)', () => {
  // `require.resolve` never EXECUTES the module (only resolves its path),
  // so this is safe despite the package being otherwise unimportable at
  // runtime under this Jest config. Resolving the bare specifier (not
  // `.../package.json`) also sidesteps modern `exports`-map encapsulation —
  // `@hocuspocus/server`'s `package.json` declares an `exports` map with no
  // `"./package.json"` entry, so that subpath is blocked from resolution.
  const distPath = require.resolve('@hocuspocus/server');
  // The installed package's own `package.json` sits two directories up from
  // `dist/hocuspocus-server.cjs`.
  const packageDir = path.dirname(path.dirname(distPath));
  const packageJson = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as { version?: string };
  const source = readFileSync(distPath, 'utf8');

  it('is installed at a 4.x version (this pin was written against 4.0.0)', () => {
    expect(packageJson.version).toBeDefined();
    expect(packageJson.version?.startsWith('4.')).toBe(true);
  });

  it('Hocuspocus.closeConnections(documentName) is a by-name registry lookup over `this.documents`', () => {
    // Locate the `closeConnections` method body (bounded by the next
    // method's JSDoc `/**` to avoid matching unrelated later code).
    const methodMatch = source.match(/closeConnections\(documentName\)\s*\{([\s\S]*?)\n\t\}/);
    expect(methodMatch).not.toBeNull();
    const body = methodMatch?.[1] ?? '';

    // The registry-scan + by-name filter our doc comment describes.
    expect(body).toMatch(/this\.documents\.forEach/);
    expect(body).toMatch(/document\.name\s*!==\s*documentName/);
  });

  it("Document.getConnections() returns this document's own attached connections, not a registry lookup", () => {
    const methodMatch = source.match(/getConnections\(\)\s*\{([\s\S]*?)\n\t\}/);
    expect(methodMatch).not.toBeNull();
    const body = methodMatch?.[1] ?? '';

    // `this.connections` is the Document's OWN Map (keyed by Connection),
    // populated by `addConnection`/`removeConnection` — independent of the
    // engine-level `documents` registry our fix works around.
    expect(body).toMatch(/this\.connections\.keys\(\)/);
  });
});
