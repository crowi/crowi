/**
 * Deterministic coverage for the B1 lint guard
 * (feature-test-parallel-db-flake-hardening, Phase 3):
 * `packages/api/.eslintrc.js`'s `no-restricted-imports` / `no-restricted-syntax`
 * override that blocks a test file from opening its own ad hoc DB connection
 * instead of going through the harness (`test/setup.ts` / `crowi-environment.js`).
 *
 * Drives the REAL `.eslintrc.js` via the ESLint Node API (`eslint` is already
 * a devDependency of this package — `packages/api/package.json`) rather than
 * re-implementing the rule config here, so a future edit to the override that
 * accidentally narrows or widens it shows up as a test failure. Every fixture
 * is linted with a virtual `filePath` under `src/hono/handlers/` (a real,
 * non-`src/test/**` directory) so ESLint's cascading config lookup resolves
 * the SAME `packages/api/.eslintrc.js` a real test file would use, and so the
 * `excludedFiles: ['src/test/**\/*']` carve-out for the harness's own
 * implementation files does not accidentally exempt these fixtures too.
 *
 * `eslint@8.57.1` ships no bundled type declarations and this repo has no
 * `@types/eslint` (see `packages/api/.eslintrc.js`'s own `no-var-requires`
 * precedent) — `require()`'d and hand-typed with the minimal surface used
 * here, same pattern as `global-setup.test.ts` / `crowi-environment.test.ts`
 * requiring their plain-CJS harness modules directly.
 */
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ESLint } = require('eslint') as { ESLint: ESLintCtor };

interface LintMessage {
  ruleId: string | null;
  severity: number;
  message: string;
}
interface LintResult {
  messages: LintMessage[];
}
interface ESLintInstance {
  lintText(code: string, options?: { filePath?: string }): Promise<LintResult[]>;
}
interface ESLintCtor {
  new (options?: { cwd?: string; useEslintrc?: boolean }): ESLintInstance;
}

const API_ROOT = path.join(__dirname, '..', '..');
// Any real, non-`src/test/**` directory works — this one is arbitrary.
// The file itself is never read from disk; `lintText`'s `filePath` only
// drives ESLint's cascading `.eslintrc.js` lookup + `overrides` glob
// matching.
const FIXTURE_PATH = path.join(API_ROOT, 'src', 'hono', 'handlers', '__eslint-db-guard-fixture__.test.ts');

/**
 * Warmed in `beforeAll` rather than built at module scope. The constructor is
 * nearly free; the cost is in `lintText`, which resolves the cascading
 * `.eslintrc.js` for the given `filePath`, loads its plugins, and cold-starts
 * the TypeScript parser. Because the cascade resolves per path, EVERY new
 * directory context this suite lints under pays its own cold start — measured
 * at 444ms for the first `src/hono/handlers/` lint and a further 1127ms for
 * the first `src/util/` one, against 1-2ms once warm. At module scope those
 * seconds land on whichever `it()` happens to reach each context first, and
 * Jest's default timeout is 5s: comfortable on an idle machine, not
 * necessarily on a loaded CI runner.
 *
 * So each distinct context is warmed here, where the slack lives, and every
 * assertion keeps the standard timeout. Warming one path is not enough — that
 * is what leaves the 1127ms on an assertion. Any new `filePath` this suite
 * starts linting under belongs in {@link WARMUP_PATHS} too.
 */
let eslint: ESLintInstance;

async function lintAt(code: string, filePath: string): Promise<LintMessage[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages;
}

async function lint(code: string): Promise<LintMessage[]> {
  return lintAt(code, FIXTURE_PATH);
}

function dbGuardMessages(messages: LintMessage[]): LintMessage[] {
  return messages.filter((m) => m.ruleId === 'no-restricted-imports' || m.ruleId === 'no-restricted-syntax');
}

/**
 * feature-redis-subscriber-crash-fix — the sibling `no-restricted-syntax`
 * override that blocks a direct `.duplicate()` call on a Redis client
 * anywhere outside `src/util/redis-opts.ts` (see that file's
 * `duplicateWithErrorHandler`) — production AND test files alike; AC-3
 * draws no test-file exception ("a direct .duplicate() call outside
 * src/util/redis-opts.ts is an ESLint error"), and no real test file needs
 * the raw call (a `FakeRedis` DEFINES a `duplicate()` method, it never
 * CALLS `.duplicate()` on something else). Unlike the DB guard above
 * (scoped to `**\/*.test.ts` / `src/test/**`, which never sets
 * `parserOptions.project`), this guard's `files: ['src/**\/*.ts']` glob
 * OVERLAPS the override that DOES set `parserOptions.project` for
 * non-`.test.ts` source outside `src/test/**` — a virtual, on-disk-
 * nonexistent fixture path there throws a parser error ("TSConfig does not
 * include this file") instead of running the rule. So the non-test fixture
 * below points `filePath` at a REAL, already-tracked production file
 * instead of a `__fixture__` name; `code` is still the arbitrary text under
 * test (`lintText`'s `code` argument is independent of what's actually on
 * disk at `filePath`) — a virtual `.test.ts` / `src/test/**` path is fine
 * to keep using as a fixture for the test-file cases below, same as the DB
 * guard above, since both are exempt from the `parserOptions.project`
 * override regardless of this guard.
 */
const DUPLICATE_GUARD_FIXTURE_PATH = path.join(API_ROOT, 'src', 'util', 'redis-database.ts');
const REDIS_OPTS_PATH = path.join(API_ROOT, 'src', 'util', 'redis-opts.ts');

function duplicateGuardMessages(messages: LintMessage[]): LintMessage[] {
  return messages.filter((m) => m.ruleId === 'no-restricted-syntax');
}

/**
 * Every distinct `filePath` context the suite lints under. Declared here,
 * below the fixture-path constants, so it references them instead of
 * repeating their values — a warm-up that drifts from the path an assertion
 * actually uses silently stops warming anything.
 */
const WARMUP_PATHS = [FIXTURE_PATH, DUPLICATE_GUARD_FIXTURE_PATH, REDIS_OPTS_PATH, path.join(API_ROOT, 'src', 'test', '__eslint-warmup-fixture__.ts')];

beforeAll(async () => {
  eslint = new ESLint({ cwd: API_ROOT, useEslintrc: true });
  for (const warmupPath of WARMUP_PATHS) {
    await lintAt('export const warm = 1;\n', warmupPath);
  }
}, 30_000);

describe('B1 DB-bypass lint guard (packages/api/.eslintrc.js)', () => {
  it('flags a MemberExpression call — mongoose.connect(...)', async () => {
    const messages = dbGuardMessages(await lint(`import mongoose from 'mongoose';\nmongoose.connect('mongodb://localhost:27017');\n`));
    expect(messages).toHaveLength(1);
    expect(messages[0].ruleId).toBe('no-restricted-syntax');
    expect(messages[0].severity).toBe(2); // 'error'
  });

  it('flags a MemberExpression call — mongoose.createConnection(...)', async () => {
    const messages = dbGuardMessages(await lint(`import mongoose from 'mongoose';\nmongoose.createConnection('mongodb://localhost:27017');\n`));
    expect(messages).toHaveLength(1);
    expect(messages[0].ruleId).toBe('no-restricted-syntax');
    expect(messages[0].severity).toBe(2);
  });

  it('flags a MemberExpression call — MongoMemoryServer.create(...)', async () => {
    const messages = dbGuardMessages(await lint(`import { MongoMemoryServer } from 'mongodb-memory-server';\nMongoMemoryServer.create();\n`));
    // Both the import itself (no-restricted-imports) and the call
    // (no-restricted-syntax) are flagged independently — the import
    // restriction blocks the module entirely, the syntax restriction
    // additionally blocks the call shape even if it were reached via a
    // re-export.
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages.some((m) => m.ruleId === 'no-restricted-imports')).toBe(true);
    expect(messages.some((m) => m.ruleId === 'no-restricted-syntax')).toBe(true);
    expect(messages.every((m) => m.severity === 2)).toBe(true);
  });

  it('flags a named import — import { connect } from "mongoose"', async () => {
    const messages = dbGuardMessages(await lint(`import { connect } from 'mongoose';\nconnect('mongodb://localhost:27017');\n`));
    expect(messages.some((m) => m.ruleId === 'no-restricted-imports')).toBe(true);
    expect(messages.every((m) => m.severity === 2)).toBe(true);
  });

  it('flags a named import — import { createConnection } from "mongoose"', async () => {
    const messages = dbGuardMessages(await lint(`import { createConnection } from 'mongoose';\ncreateConnection('mongodb://localhost:27017');\n`));
    expect(messages.some((m) => m.ruleId === 'no-restricted-imports')).toBe(true);
  });

  it('flags a destructuring assignment — const { connect } = mongoose', async () => {
    const messages = dbGuardMessages(await lint(`import mongoose from 'mongoose';\nconst { connect } = mongoose;\nconnect('mongodb://localhost:27017');\n`));
    expect(messages.some((m) => m.ruleId === 'no-restricted-syntax')).toBe(true);
    expect(messages.every((m) => m.severity === 2)).toBe(true);
  });

  it('flags a destructuring assignment — const { createConnection } = mongoose', async () => {
    const messages = dbGuardMessages(
      await lint(`import mongoose from 'mongoose';\nconst { createConnection } = mongoose;\ncreateConnection('mongodb://localhost:27017');\n`),
    );
    expect(messages.some((m) => m.ruleId === 'no-restricted-syntax')).toBe(true);
  });

  it('flags a bare `mongodb` driver import', async () => {
    const messages = dbGuardMessages(await lint(`import { MongoClient } from 'mongodb';\nvoid MongoClient;\n`));
    expect(messages.some((m) => m.ruleId === 'no-restricted-imports')).toBe(true);
  });

  it('does NOT flag the harness-blessed default import + model registration (control — proves the rule is not over-broad)', async () => {
    const messages = dbGuardMessages(await lint(`import mongoose from 'mongoose';\nmongoose.model('Foo', new mongoose.Schema({}));\n`));
    expect(messages).toHaveLength(0);
  });

  it('does NOT flag destructuring an unrelated member off mongoose (e.g. Types) — only connect/createConnection are restricted', async () => {
    const messages = dbGuardMessages(await lint(`import mongoose from 'mongoose';\nconst { Types } = mongoose;\nvoid Types;\n`));
    expect(messages).toHaveLength(0);
  });

  it(
    'does NOT flag the same violating code when the virtual filePath is inside src/test/** — the ' +
      'harness-implementation carve-out `.eslintrc.js` requires (AC2), not a coverage gap: every file ' +
      'in this directory today is either harness implementation or a harness-only unit test that ' +
      "legitimately opens a real connection (see this rule's own doc comment in `.eslintrc.js`)",
    async () => {
      const [result] = await eslint.lintText(`import mongoose from 'mongoose';\nmongoose.connect('mongodb://localhost:27017');\n`, {
        filePath: path.join(API_ROOT, 'src', 'test', '__eslint-db-guard-fixture__.test.ts'),
      });
      expect(dbGuardMessages(result.messages)).toHaveLength(0);
    },
  );
});

describe('feature-redis-subscriber-crash-fix duplicate() guard (packages/api/.eslintrc.js)', () => {
  it('flags a direct .duplicate() call on a production Redis client', async () => {
    const messages = duplicateGuardMessages(await lintAt(`const dup = client.duplicate();\nvoid dup;\n`, DUPLICATE_GUARD_FIXTURE_PATH));
    expect(messages).toHaveLength(1);
    expect(messages[0].ruleId).toBe('no-restricted-syntax');
    expect(messages[0].severity).toBe(2); // 'error'
    expect(messages[0].message).toContain('duplicateWithErrorHandler');
  });

  it('does NOT flag a call through duplicateWithErrorHandler (control — proves the rule targets the raw call, not the helper)', async () => {
    const messages = duplicateGuardMessages(
      await lintAt(
        `import { duplicateWithErrorHandler } from 'src/util/redis-opts';\nconst dup = duplicateWithErrorHandler(client, 'label');\nvoid dup;\n`,
        DUPLICATE_GUARD_FIXTURE_PATH,
      ),
    );
    expect(messages).toHaveLength(0);
  });

  it('does NOT flag a direct .duplicate() call inside src/util/redis-opts.ts itself — the one file the guard excludes', async () => {
    const messages = duplicateGuardMessages(await lintAt(`const dup = client.duplicate();\nvoid dup;\n`, REDIS_OPTS_PATH));
    expect(messages).toHaveLength(0);
  });

  it('flags a direct .duplicate() call in a *.test.ts file too — AC-3 draws no test-file exception, only src/util/redis-opts.ts is exempt', async () => {
    const messages = duplicateGuardMessages(
      await lintAt(
        `const dup = client.duplicate();\nvoid dup;\n`,
        path.join(API_ROOT, 'src', 'hono', 'handlers', '__eslint-duplicate-guard-fixture__.test.ts'),
      ),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].ruleId).toBe('no-restricted-syntax');
    expect(messages[0].severity).toBe(2); // 'error'
    expect(messages[0].message).toContain('duplicateWithErrorHandler');
  });

  it('flags a direct .duplicate() call under src/test/** too — same reasoning as the *.test.ts case above', async () => {
    const messages = duplicateGuardMessages(
      await lintAt(`const dup = client.duplicate();\nvoid dup;\n`, path.join(API_ROOT, 'src', 'test', '__eslint-duplicate-guard-fixture__.ts')),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].ruleId).toBe('no-restricted-syntax');
    expect(messages[0].severity).toBe(2); // 'error'
  });
});
