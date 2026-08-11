/**
 * feature-radix-upgrade-and-single-source — regression coverage for the
 * `no-restricted-imports` guard in the REAL `packages/web/eslint.config.mjs`
 * that keeps Radix primitives on a single import source (`radix-ui`).
 *
 * `dda4ba72` moved the overlay wrappers (`Dialog` / `Select` / ...) from
 * direct `@radix-ui/react-*` packages to the `radix-ui` meta package because
 * two independently-versioned copies of `@radix-ui/react-dismissable-layer`
 * (pulled in by leftover direct dependencies) kept separate module-local
 * body-lock registries — closing an overlay registered in one copy could
 * leave `document.body.style.pointerEvents` stuck at `'none'`, registered by
 * the other. A direct `@radix-ui/react-*` import re-introduces exactly that
 * risk, so this drives the REAL flat config through the ESLint Node API
 * (rather than re-implementing the rule here) so a future edit that narrows
 * or removes the guard shows up as a test failure, same pattern as
 * `packages/api/src/test/eslint-db-guard.test.ts#lintAt`.
 *
 * ESLint v9 (`packages/web/package.json`'s `eslint: "^9"`) uses flat config
 * natively — no `useEslintrc` legacy option needed; `cwd: WEB_ROOT` is
 * enough for `new ESLint()` to discover `eslint.config.mjs`.
 */
import path from 'node:path';
import { ESLint, type Linter } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const WEB_ROOT = path.join(__dirname, '..');
// Any real, tracked `.ts`/`.tsx` path under `src/` works — `lintText`'s
// `filePath` only drives ESLint's flat-config file matching, the file is
// never actually read from disk (the `code` argument is independent of
// whatever is really on disk at this path).
const FIXTURE_PATH = path.join(WEB_ROOT, 'src', 'components', 'ui', '__radix-import-guard-fixture__.tsx');

/**
 * Warmed in `beforeAll` rather than built at module scope, because the
 * constructor is nearly free while the FIRST `lintText` pays for everything:
 * discovering `eslint.config.mjs`, importing it (Next core-web-vitals + the
 * TypeScript configs, six plugins between them), normalizing the flat config,
 * and cold-starting the TypeScript parser. ESLint caches all of it, so the
 * first call costs ~1s and the rest 3-4ms. At module scope that second is
 * billed to whichever `it()` happens to run first, which fits inside the
 * default 5s timeout on an idle machine and does not on a loaded one.
 *
 * Charging it to the hook keeps every assertion on the standard timeout —
 * the setup gets the slack, the guard itself stays strict. The hook still
 * fails on a config import error or a genuine hang.
 *
 * The warm-up has to be a real `lintText` through the same `.tsx` fixture
 * path: constructing the instance, or calling `calculateConfigForFile`,
 * leaves the parser cold and the cost back on the first assertion.
 */
let eslint: ESLint;

beforeAll(async () => {
  eslint = new ESLint({ cwd: WEB_ROOT });
  await lintAt("import { cn } from '@/lib/utils';\nvoid cn;\n", FIXTURE_PATH);
}, 30_000);

async function lintAt(code: string, filePath: string): Promise<Linter.LintMessage[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages;
}

function restrictedImportMessages(messages: Linter.LintMessage[]): Linter.LintMessage[] {
  return messages.filter((m) => m.ruleId === 'no-restricted-imports');
}

describe('Radix single-import-source lint guard (packages/web/eslint.config.mjs)', () => {
  it('flags a direct @radix-ui/react-dialog import', async () => {
    const messages = restrictedImportMessages(await lintAt("import { Dialog } from '@radix-ui/react-dialog';\nvoid Dialog;\n", FIXTURE_PATH));
    expect(messages).toHaveLength(1);
    expect(messages[0].severity).toBe(2); // 'error'
  });

  it('flags a direct @radix-ui/react-slot import (the button.tsx#Button asChild primitive)', async () => {
    const messages = restrictedImportMessages(await lintAt("import { Slot } from '@radix-ui/react-slot';\nvoid Slot;\n", FIXTURE_PATH));
    expect(messages).toHaveLength(1);
    expect(messages[0].severity).toBe(2);
  });

  it('flags a direct @radix-ui/react-avatar namespace import (the avatar.tsx#Avatar primitive)', async () => {
    const messages = restrictedImportMessages(
      await lintAt("import * as AvatarPrimitive from '@radix-ui/react-avatar';\nvoid AvatarPrimitive;\n", FIXTURE_PATH),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].severity).toBe(2);
  });

  it('flags an arbitrary @radix-ui/react-* import that is not one of the packages this feature happens to migrate (proves the guard matches the `@radix-ui/react-*` wildcard pattern, not an enumerated allowlist of the 3 packages exercised above — a config edit that narrowed the pattern to only dialog/slot/avatar would still pass the tests above but must fail this one)', async () => {
    const messages = restrictedImportMessages(
      await lintAt("import { Whatever } from '@radix-ui/react-this-package-is-not-enumerated-anywhere-in-this-file';\nvoid Whatever;\n", FIXTURE_PATH),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].severity).toBe(2);
  });

  it('does NOT flag the meta `radix-ui` package import (control — proves the rule targets direct packages, not Radix generally)', async () => {
    const messages = restrictedImportMessages(await lintAt("import { Dialog } from 'radix-ui';\nvoid Dialog;\n", FIXTURE_PATH));
    expect(messages).toHaveLength(0);
  });

  it('does NOT flag an unrelated, non-Radix import (control — proves the rule is not over-broad)', async () => {
    const messages = restrictedImportMessages(await lintAt("import { cn } from '@/lib/utils';\nvoid cn;\n", FIXTURE_PATH));
    expect(messages).toHaveLength(0);
  });
});
