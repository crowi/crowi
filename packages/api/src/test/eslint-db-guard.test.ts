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

const eslint = new ESLint({ cwd: API_ROOT, useEslintrc: true });

async function lint(code: string): Promise<LintMessage[]> {
  const [result] = await eslint.lintText(code, { filePath: FIXTURE_PATH });
  return result.messages;
}

function dbGuardMessages(messages: LintMessage[]): LintMessage[] {
  return messages.filter((m) => m.ruleId === 'no-restricted-imports' || m.ruleId === 'no-restricted-syntax');
}

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
