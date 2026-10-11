/**
 * Regression coverage for the REAL flat configs of every lint workspace after
 * the ESLint 10 upgrade and the move off `eslint-config-next`. Nothing is
 * mocked: each case builds an `ESLint({ cwd })` against the config on disk and
 * lints in-memory fixtures at real repo paths.
 *
 * The expected rule maps below are literals, deliberately not derived from the
 * plugins' own `recommended` presets — a preset that silently drops a rule must
 * fail here instead of shrinking the expectation with it.
 */
import { type ChildProcessByStdio, spawn } from 'node:child_process';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { ESLint, type Linter } from 'eslint';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const abs = (rel: string) => path.join(REPO_ROOT, rel);

type Severity = 1 | 2;

const WORKSPACES = {
  cli: { cwd: 'packages/cli', files: ['packages/cli/src/cli.ts'] },
  e2e: { cwd: 'packages/e2e', files: ['packages/e2e/src/auth.ts', 'packages/e2e/playwright.config.ts'] },
  api: { cwd: 'packages/api', files: ['packages/api/src/crowi/index.ts'] },
  collab: { cwd: 'packages/collab', files: ['packages/collab/src/index.ts'] },
  search: { cwd: 'packages/plugin-search-mongo', files: ['packages/plugin-search-mongo/src/index.ts'] },
  web: { cwd: 'packages/web', files: ['packages/web/src/components/ui/button.tsx', 'packages/web/src/lib/utils.ts'] },
  site: { cwd: 'apps/crowi-site', files: ['apps/crowi-site/src/app/layout.tsx', 'apps/crowi-site/src/lib/source.ts'] },
} as const;

const NEXT_WARN = [
  'google-font-display',
  'google-font-preconnect',
  'next-script-for-ga',
  'no-async-client-component',
  'no-before-interactive-script-outside-document',
  'no-css-tags',
  'no-head-element',
  'no-img-element',
  'no-page-custom-font',
  'no-styled-jsx-in-document',
  'no-title-in-document-head',
  'no-typos',
  'no-unwanted-polyfillio',
];
const NEXT_ERROR = [
  'no-html-link-for-pages',
  'no-sync-scripts',
  'inline-script-id',
  'no-assign-module-variable',
  'no-document-import-in-page',
  'no-duplicate-head',
  'no-head-import-in-document',
  'no-script-component-in-head',
];
const HOOKS_WARN = ['exhaustive-deps', 'incompatible-library', 'unsupported-syntax'];
const HOOKS_ERROR = [
  'rules-of-hooks',
  'static-components',
  'use-memo',
  'preserve-manual-memoization',
  'immutability',
  'globals',
  'refs',
  'set-state-in-effect',
  'error-boundaries',
  'purity',
  'set-state-in-render',
  'config',
  'gating',
];
const TS_WARN = ['no-unused-expressions', 'no-unused-vars'];
const TS_ERROR = [
  'ban-ts-comment',
  'no-array-constructor',
  'no-duplicate-enum-values',
  'no-empty-object-type',
  'no-explicit-any',
  'no-extra-non-null-assertion',
  'no-misused-new',
  'no-namespace',
  'no-non-null-asserted-optional-chain',
  'no-require-imports',
  'no-this-alias',
  'no-unnecessary-type-constraint',
  'no-unsafe-declaration-merging',
  'no-unsafe-function-type',
  'no-wrapper-object-types',
  'prefer-as-const',
  'prefer-namespace-keyword',
  'triple-slash-reference',
];

const EXPECTED_RULE_SEVERITIES: Record<string, Severity> = {};
for (const [ns, warn, error] of [
  ['@next/next', NEXT_WARN, NEXT_ERROR],
  ['react-hooks', HOOKS_WARN, HOOKS_ERROR],
  ['@typescript-eslint', TS_WARN, TS_ERROR],
] as const) {
  for (const name of warn) EXPECTED_RULE_SEVERITIES[`${ns}/${name}`] = 1;
  for (const name of error) EXPECTED_RULE_SEVERITIES[`${ns}/${name}`] = 2;
}
// Detects nothing in any released version of the plugin, so it is neither
// expected nor allowed to be enabled.
const NO_OP_HOOKS_RULE = 'react-hooks/component-hook-factories';

const PARITY_PREFIXES = ['@next/next/', 'react-hooks/', '@typescript-eslint/'] as const;
const REACT_RULES = [
  '@eslint-react/no-missing-key',
  '@eslint-react/jsx-no-children-prop',
  '@eslint-react/dom-no-dangerously-set-innerhtml-with-children',
  '@eslint-react/jsx-no-comment-textnodes',
  '@eslint-react/no-missing-component-display-name',
];

function toSeverity(entry: Linter.RuleEntry | undefined): 0 | Severity {
  const value = Array.isArray(entry) ? entry[0] : entry;
  if (value === 'warn' || value === 1) return 1;
  if (value === 'error' || value === 2) return 2;
  return 0;
}

function activeRuleSeverities(rules: Linter.RulesRecord, prefixes: readonly string[]): Record<string, Severity> {
  const out: Record<string, Severity> = {};
  for (const id of Object.keys(rules).sort()) {
    if (!prefixes.some((p) => id.startsWith(p))) continue;
    const severity = toSeverity(rules[id]);
    if (severity !== 0) out[id] = severity;
  }
  return out;
}

type EslintLike = Pick<ESLint, 'lintText' | 'calculateConfigForFile' | 'isPathIgnored'>;

/**
 * typescript-eslint records the directory of every config file that loads it
 * in process-global state and refuses to parse once two are present without an
 * explicit tsconfigRootDir. web and site each load it from their own config,
 * so the site config is exercised in a child process of its own — the same
 * way a real `eslint` run sees it — and never meets web's in this one.
 */
class ChildESLint implements EslintLike {
  private child: ChildProcessByStdio<Writable, Readable, null>;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private seq = 0;

  constructor(cwd: string) {
    const script = `
      import { ESLint } from 'eslint';
      import { createInterface } from 'node:readline';
      const eslint = new ESLint({ cwd: process.cwd() });
      createInterface({ input: process.stdin }).on('line', async (line) => {
        const { id, op, args } = JSON.parse(line);
        try {
          process.stdout.write(JSON.stringify({ id, result: await eslint[op](...args) }) + '\\n');
        } catch (e) {
          process.stdout.write(JSON.stringify({ id, error: String(e && e.stack || e) }) + '\\n');
        }
      });
    `;
    this.child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      const { id, result, error } = JSON.parse(line);
      const waiter = this.pending.get(id);
      this.pending.delete(id);
      if (error) waiter?.reject(new Error(error));
      else waiter?.resolve(result);
    });
    this.child.on('exit', () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error('eslint child exited'));
      this.pending.clear();
    });
  }

  private call<T>(op: string, args: unknown[]): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.child.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
    });
  }

  lintText = ((code: string, options: unknown) => this.call('lintText', [code, options])) as ESLint['lintText'];
  calculateConfigForFile = ((filePath: string) => this.call('calculateConfigForFile', [filePath])) as ESLint['calculateConfigForFile'];
  isPathIgnored = ((filePath: string) => this.call('isPathIgnored', [filePath])) as ESLint['isPathIgnored'];

  close() {
    this.child.kill();
  }
}

const isSite = (rel: string) => rel.startsWith('apps/crowi-site/');

async function lintAt(eslint: EslintLike, code: string, filePath: string): Promise<Linter.LintMessage[]> {
  const results = await eslint.lintText(code, { filePath });
  expect(results).toHaveLength(1);
  const [result] = results;
  expect(result.fatalErrorCount, `fatal diagnostics at ${filePath}: ${JSON.stringify(result.messages)}`).toBe(0);
  const ignored = result.messages.filter((m) => /ignored/i.test(m.message) && m.ruleId === null);
  expect(ignored, `${filePath} was ignored`).toHaveLength(0);
  return result.messages;
}

async function rulesFor(eslint: EslintLike, relPath: string): Promise<Linter.RulesRecord> {
  const config = await eslint.calculateConfigForFile(abs(relPath));
  expect(config, `no config resolved for ${relPath}`).toBeDefined();
  return ((config as Linter.Config).rules ?? {}) as Linter.RulesRecord;
}

const eslints = {} as Record<keyof typeof WORKSPACES, EslintLike>;
let rootEslint: EslintLike;
let rootSiteEslint: ChildESLint;
const children: ChildESLint[] = [];

beforeAll(async () => {
  // Warm sequentially: the first lintText per instance pays for config import
  // and parser cold start, which would otherwise be billed to one assertion.
  for (const key of Object.keys(WORKSPACES) as (keyof typeof WORKSPACES)[]) {
    const ws = WORKSPACES[key];
    if (key === 'site') {
      const child = new ChildESLint(abs(ws.cwd));
      children.push(child);
      eslints[key] = child;
    } else {
      eslints[key] = new ESLint({ cwd: abs(ws.cwd) });
    }
    await lintAt(eslints[key], 'export const warm = 1;\n', abs(ws.files[0]));
  }
  rootEslint = new ESLint({ cwd: REPO_ROOT });
  rootSiteEslint = new ChildESLint(REPO_ROOT);
  children.push(rootSiteEslint);
}, 120_000);

afterAll(() => {
  for (const child of children) child.close();
});

// Each case loads real ESLint configs for every workspace file; a 4-CPU CI runner
// takes about 5s for the cross-cwd case, right at Vitest's default timeout.
describe('ESLint config compatibility', { timeout: 30_000 }, () => {
  describe.each(['web', 'site'] as const)('%s', (key) => {
    const ws = WORKSPACES[key];

    it('preserves active Next, hooks and TypeScript rules for each TS/TSX representative', async () => {
      for (const file of ws.files) {
        const actual = activeRuleSeverities(await rulesFor(eslints[key], file), PARITY_PREFIXES);
        expect(actual[NO_OP_HOOKS_RULE], `${NO_OP_HOOKS_RULE} must stay disabled (${file})`).toBeUndefined();
        expect(actual, file).toEqual(EXPECTED_RULE_SEVERITIES);
      }
    });

    it('enables exactly the five @eslint-react rules', async () => {
      for (const file of ws.files) {
        const actual = Object.keys(activeRuleSeverities(await rulesFor(eslints[key], file), ['@eslint-react/']));
        expect(actual.sort()).toEqual([...REACT_RULES].sort());
      }
    });

    it('does not carry the removed React / a11y / import presets', async () => {
      const rules = await rulesFor(eslints[key], ws.files[0]);
      const leftovers = activeRuleSeverities(rules, ['react/', 'jsx-a11y/', 'import/']);
      expect(leftovers).toEqual({});
    });

    it('keeps set-state-in-effect at error', async () => {
      const rules = await rulesFor(eslints[key], ws.files[0]);
      expect(toSeverity(rules['react-hooks/set-state-in-effect'])).toBe(2);
    });

    const tsxPath = abs(`${ws.cwd}/src/__compat-fixture__.tsx`);
    const tsPath = abs(`${ws.cwd}/src/__compat-fixture__.ts`);

    const cases: { name: string; ruleId: string; severity: Severity; bad: string; good: string; filePath: string }[] = [
      {
        name: 'reports missing JSX keys',
        ruleId: '@eslint-react/no-missing-key',
        severity: 2,
        bad: 'export function List({ items }: { items: { id: string }[] }) {\n  return <div>{items.map((i) => <span>{i.id}</span>)}</div>;\n}\n',
        good: 'export function List({ items }: { items: { id: string }[] }) {\n  return <div>{items.map((i) => <span key={i.id}>{i.id}</span>)}</div>;\n}\n',
        filePath: tsxPath,
      },
      {
        name: 'rejects explicit children props',
        ruleId: '@eslint-react/jsx-no-children-prop',
        severity: 2,
        bad: 'export function A() {\n  return <div children="text" />;\n}\n',
        good: 'export function A() {\n  return <div>text</div>;\n}\n',
        filePath: tsxPath,
      },
      {
        name: 'rejects inner HTML with children',
        ruleId: '@eslint-react/dom-no-dangerously-set-innerhtml-with-children',
        severity: 2,
        bad: "export function A() {\n  return <div dangerouslySetInnerHTML={{ __html: 'x' }}>text</div>;\n}\n",
        good: "export function A() {\n  return <div dangerouslySetInnerHTML={{ __html: 'x' }} />;\n}\n",
        filePath: tsxPath,
      },
      {
        name: 'rejects comment text nodes',
        ruleId: '@eslint-react/jsx-no-comment-textnodes',
        severity: 2,
        bad: 'export function A() {\n  return <div>// comment</div>;\n}\n',
        good: 'export function A() {\n  return <div>{/* comment */}</div>;\n}\n',
        filePath: tsxPath,
      },
      {
        name: 'reports missing component display names',
        ruleId: '@eslint-react/no-missing-component-display-name',
        severity: 2,
        bad: "import { memo } from 'react';\n\nexport const Anonymous = memo(() => <div />);\n",
        good: "import { memo } from 'react';\n\nexport const Named = memo(function Named() {\n  return <div />;\n});\n",
        filePath: tsxPath,
      },
      {
        name: 'reports img elements',
        ruleId: '@next/next/no-img-element',
        severity: 1,
        bad: 'export function A() {\n  return <img src="/image.png" alt="image" />;\n}\n',
        good: 'export function A() {\n  return <div />;\n}\n',
        filePath: tsxPath,
      },
      {
        name: 'reports synchronous scripts',
        ruleId: '@next/next/no-sync-scripts',
        severity: 2,
        bad: 'export function A() {\n  return <script src="/app.js" />;\n}\n',
        good: 'export function A() {\n  return <script async src="/app.js" />;\n}\n',
        filePath: tsxPath,
      },
      {
        name: 'reports conditional hooks',
        ruleId: 'react-hooks/rules-of-hooks',
        severity: 2,
        bad: "import { useState } from 'react';\n\nexport function A({ on }: { on: boolean }) {\n  if (on) {\n    const [s] = useState(0);\n    return <div>{s}</div>;\n  }\n  return null;\n}\n",
        good: "import { useState } from 'react';\n\nexport function A({ on }: { on: boolean }) {\n  const [s] = useState(0);\n  return on ? <div>{s}</div> : null;\n}\n",
        filePath: tsxPath,
      },
      {
        name: 'reports missing effect dependencies',
        ruleId: 'react-hooks/exhaustive-deps',
        severity: 1,
        bad: "import { useEffect } from 'react';\n\nexport function A({ v }: { v: number }) {\n  useEffect(() => {\n    document.title = String(v);\n  }, []);\n  return null;\n}\n",
        good: "import { useEffect } from 'react';\n\nexport function A({ v }: { v: number }) {\n  useEffect(() => {\n    document.title = String(v);\n  }, [v]);\n  return null;\n}\n",
        filePath: tsxPath,
      },
      {
        name: 'reports explicit any',
        ruleId: '@typescript-eslint/no-explicit-any',
        severity: 2,
        bad: 'export function f(x: any) {\n  return x;\n}\n',
        good: 'export function f(x: unknown) {\n  return x;\n}\n',
        filePath: tsPath,
      },
    ];

    it.each(cases)('$name', async ({ ruleId, severity, bad, good, filePath }) => {
      const hit = (await lintAt(eslints[key], bad, filePath)).filter((m) => m.ruleId === ruleId);
      expect(hit.length, `${ruleId} not reported`).toBeGreaterThan(0);
      expect(hit[0].severity).toBe(severity);
      const clean = (await lintAt(eslints[key], good, filePath)).filter((m) => m.ruleId === ruleId);
      expect(clean).toEqual([]);
    });
  });

  it('resolves the same config from workspace and repository cwd', async () => {
    for (const key of Object.keys(WORKSPACES) as (keyof typeof WORKSPACES)[]) {
      for (const file of WORKSPACES[key].files) {
        const fromWorkspace = await rulesFor(eslints[key], file);
        const fromRoot = await rulesFor(isSite(file) ? rootSiteEslint : rootEslint, file);
        expect(fromRoot, file).toEqual(fromWorkspace);
      }
    }
  });

  it('keeps typed parsing disabled', async () => {
    for (const key of Object.keys(WORKSPACES) as (keyof typeof WORKSPACES)[]) {
      for (const file of WORKSPACES[key].files) {
        const config = (await eslints[key].calculateConfigForFile(abs(file))) as Linter.Config;
        const parserOptions = (config.languageOptions?.parserOptions ?? {}) as Record<string, unknown>;
        expect(parserOptions.project, file).toBeUndefined();
        expect(parserOptions.projectService, file).toBeFalsy();
      }
    }
  });

  it('does not enable new ESLint recommended rules', async () => {
    for (const key of Object.keys(WORKSPACES) as (keyof typeof WORKSPACES)[]) {
      for (const file of WORKSPACES[key].files) {
        const rules = await rulesFor(eslints[key], file);
        for (const id of ['no-unassigned-vars', 'no-useless-assignment', 'preserve-caught-error']) {
          expect(toSeverity(rules[id]), `${id} at ${file}`).toBe(0);
        }
      }
    }
  });

  describe.each(['web', 'site'] as const)('%s file selection', (key) => {
    const cwd = WORKSPACES[key].cwd;
    const generated =
      key === 'web'
        ? ['.next/x.js', 'out/x.js', 'build/x.js', 'next-env.d.ts', '.next-e2e/x.js', 'src/paraglide/x.ts', 'src/.paraglide-meta/x.ts']
        : ['.next/x.js', 'out/x.js', 'build/x.js', 'next-env.d.ts', '.source/x.ts'];

    it('ignores generated outputs only', async () => {
      for (const rel of generated) {
        expect(await eslints[key].isPathIgnored(abs(`${cwd}/${rel}`)), rel).toBe(true);
      }
      for (const rel of ['src/index.ts', 'src/lib/x.ts', 'eslint.config.mjs']) {
        expect(await eslints[key].isPathIgnored(abs(`${cwd}/${rel}`)), rel).toBe(false);
      }
    });

    it('parses existing source extensions', async () => {
      const samples: [string, string][] = [
        ['js', 'export const a = 1;\n'],
        ['jsx', 'export const a = <div />;\n'],
        ['mjs', 'export const a = 1;\n'],
        ['ts', 'export const a: number = 1;\n'],
        ['tsx', 'export const a = <div />;\n'],
        ['mts', 'export const a: number = 1;\n'],
        ['cts', 'export const a: number = 1;\n'],
        ['cjs', 'module.exports = {};\n'],
      ];
      for (const [ext, code] of samples) {
        await lintAt(eslints[key], code, abs(`${cwd}/src/__compat-fixture__.${ext}`));
      }
    });
  });
});
