import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';

import { version as pkgVersion } from '../package.json';
import { createProgram, getGlobalOptions } from './cli';
import { registerCreate } from './commands/create';
import { registerEdit } from './commands/edit';
import { registerGet } from './commands/get';
import { registerUpdate } from './commands/update';
import * as capabilityModule from './lib/capability';
import { upsertProfile } from './lib/config';
import * as editorModule from './lib/editor';
import { CliError, EXIT, setRefreshHook } from './lib/http';

/**
 * Profile-option discoverability + command-side precedence (RFC: CLI
 * profile discoverability). Built on the REAL `createProgram()` tree (not a
 * hand-rolled stand-in) so these tests fail if a future change to any
 * `registerXxx()` breaks the `-p, --profile <alias>` wiring or reintroduces
 * the "declared only at root, invisible in subcommand help" gap.
 */

function findCommand(parent: Command, name: string): Command {
  const found = parent.commands.find((c) => c.name() === name);
  if (!found) throw new Error(`command not registered: ${name} (under ${parent.name()})`);
  return found;
}

describe('createProgram — -p, --profile <alias> help visibility (AC-1)', () => {
  it('shows --profile on the root program', () => {
    const program = createProgram();
    expect(program.helpInformation()).toContain('-p, --profile <alias>');
  });

  it('shows --profile on a single (leaf, directly under root) command: login', () => {
    const program = createProgram();
    expect(findCommand(program, 'login').helpInformation()).toContain('-p, --profile <alias>');
  });

  it('shows --profile on a single (leaf, directly under root) command: search', () => {
    const program = createProgram();
    expect(findCommand(program, 'search').helpInformation()).toContain('-p, --profile <alias>');
  });

  it('shows --profile on a nested leaf command: comment add', () => {
    const program = createProgram();
    const comment = findCommand(program, 'comment');
    expect(findCommand(comment, 'add').helpInformation()).toContain('-p, --profile <alias>');
  });

  it('shows --profile on the group command itself: comment', () => {
    const program = createProgram();
    expect(findCommand(program, 'comment').helpInformation()).toContain('-p, --profile <alias>');
  });
});

describe('login accepts --profile on either side of the URL (AC-1)', () => {
  it.each([
    ['before the url', ['login', '--profile', 'alias1', 'https://wiki.example.test']],
    ['after the url', ['login', 'https://wiki.example.test', '--profile', 'alias1']],
  ])('parses --profile %s', async (_label, args) => {
    const program = createProgram();
    program.exitOverride();
    let capturedUrl: string | undefined;
    let capturedProfile: string | undefined;
    findCommand(program, 'login').action(async (url: string, _options: unknown, command: Command) => {
      capturedUrl = url;
      capturedProfile = getGlobalOptions(command).profile;
    });

    await program.parseAsync(args, { from: 'user' });

    expect(capturedUrl).toBe('https://wiki.example.test');
    expect(capturedProfile).toBe('alias1');
  });
});

describe('command-side --profile wins over root-side (AC-2)', () => {
  beforeEach(() => {
    // The version-skew probe is exercised separately below; keep it a no-op
    // here so these tests never depend on network / a real profile store.
    jest.spyOn(capabilityModule, 'maybeWarnVersionSkew').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  type Case = { label: string; args: string[]; expected: string | undefined; nested?: boolean };
  const cases: Case[] = [
    { label: 'root-side only', args: ['--profile', 'root1', 'login', 'https://x.example'], expected: 'root1' },
    { label: 'command-side only (--profile value)', args: ['login', 'https://x.example', '--profile', 'child1'], expected: 'child1' },
    {
      label: 'root + command-side: command-side wins',
      args: ['--profile', 'root1', 'login', 'https://x.example', '--profile', 'child1'],
      expected: 'child1',
    },
    {
      label: 'command-side --profile=value wins over root-side',
      args: ['--profile', 'root1', 'login', 'https://x.example', '--profile=child2'],
      expected: 'child2',
    },
    {
      label: 'command-side -p value wins over root-side',
      args: ['--profile', 'root1', 'login', 'https://x.example', '-p', 'child3'],
      expected: 'child3',
    },
    {
      label: 'command-side -pvalue (combined) wins over root-side',
      args: ['--profile', 'root1', 'login', 'https://x.example', '-pchild4'],
      expected: 'child4',
    },
    {
      label: 'nested group command (comment add): command-side wins',
      args: ['--profile', 'root1', 'comment', 'add', 'p1', '--profile', 'child5'],
      expected: 'child5',
      nested: true,
    },
    {
      label: '-- boundary: a "--profile" after it is literal, not an option — falls back to root-side',
      args: ['--profile', 'root1', 'login', 'https://x.example', '--', '--profile', 'ignored'],
      expected: 'root1',
    },
    {
      label: 'neither side given: profile is undefined',
      args: ['login', 'https://x.example'],
      expected: undefined,
    },
  ];

  it.each(cases)('$label', async ({ args, expected, nested }) => {
    const program = createProgram();
    program.exitOverride();
    let actionProfile: string | undefined;

    const target = nested ? findCommand(findCommand(program, 'comment'), 'add') : findCommand(program, 'login');
    target.action(async (..._callArgs: unknown[]) => {
      const command = _callArgs[_callArgs.length - 1] as Command;
      actionProfile = getGlobalOptions(command).profile;
    });

    await program.parseAsync(args, { from: 'user' });

    expect(actionProfile).toBe(expected);
  });
});

describe('skew probe and command action agree on the resolved --profile (AC-2)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes the same command-side profile to both maybeWarnVersionSkew and the action', async () => {
    // `login` opts OUT of the skew probe (pre-auth, nothing to probe with —
    // see `registerLogin`); use `search`, which stays on the probed surface
    // (see `skew.test.ts`).
    const skewSpy = jest.spyOn(capabilityModule, 'maybeWarnVersionSkew').mockResolvedValue(undefined);
    const program = createProgram();
    program.exitOverride();
    let actionProfile: string | undefined;
    findCommand(program, 'search').action(async (_query: string, _options: unknown, command: Command) => {
      actionProfile = getGlobalOptions(command).profile;
    });

    await program.parseAsync(['--profile', 'root1', 'search', 'release notes', '--profile', 'child1'], { from: 'user' });

    expect(actionProfile).toBe('child1');
    expect(skewSpy).toHaveBeenCalledWith(expect.objectContaining({ profile: 'child1' }));
  });

  it('does not probe commands that opt out (e.g. profiles), even with a dual profile', async () => {
    const skewSpy = jest.spyOn(capabilityModule, 'maybeWarnVersionSkew').mockResolvedValue(undefined);
    const program = createProgram();
    program.exitOverride();
    // Replace the real action (would touch the config file / stdout) —
    // this test only cares about the skew-probe opt-out wiring.
    findCommand(program, 'profiles').action(() => {});

    await program.parseAsync(['--profile', 'root1', 'profiles'], { from: 'user' });

    expect(skewSpy).not.toHaveBeenCalled();
  });
});

describe('createProgram — --version reports the published package version', () => {
  // Regression: the version was a hardcoded `'0.1.0-dev'` literal, so
  // `crowi --version` kept printing the pre-release scaffold string long
  // after the package had been published (`1.0.0-alpha.2` at the time this
  // was found). A user reporting a bug could not tell us what they were
  // running. Read from package.json rather than asserting a fixed string,
  // so this keeps passing across releases and only fails if the wiring is
  // broken again.
  it('matches the version in package.json', () => {
    expect(createProgram().version()).toBe(pkgVersion);
  });

  it('does not report a hardcoded development placeholder', () => {
    expect(createProgram().version()).not.toMatch(/-dev$/);
  });

  // The two assertions above compare the running program to the same
  // package.json it reads, so they would still pass if someone replaced the
  // import with a literal that happens to equal today's version — which is
  // exactly the regression this block exists to prevent. Assert the wiring
  // itself, not just the value it currently produces.
  it('takes the version from package.json rather than a literal', () => {
    const source = readFileSync(join(__dirname, 'cli.ts'), 'utf8');
    expect(source).toMatch(/import \{ version as CLI_VERSION \} from '\.\.\/package\.json'/);
    expect(source).not.toMatch(/\.version\(\s*['"]/);
  });
});

/**
 * RFC-0020 §7 — `create` / `update --type`,
 * `edit`'s temp-file extension, and `get --json`'s `contentType`. Follows
 * `commands/attach.test.ts`'s local `build()` + mocked-`fetch` pattern
 * (rather than `createProgram()`'s full tree) since these tests drive real
 * command actions end-to-end, not just option parsing.
 */
describe('RFC-0020 §7 — content_type / --type (create, update, edit, get)', () => {
  type FetchMock = jest.Mock<Promise<Response>, [string, RequestInit]>;

  function jsonResponse(status: number, body: unknown): Response {
    return { ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) } as Response;
  }

  let fetchMock: FetchMock;
  const originalFetch = global.fetch;
  let tmpRoot: string;
  const ORIGINAL_XDG = process.env.XDG_CONFIG_HOME;
  let stderr: jest.SpyInstance;
  let stdout: jest.SpyInstance;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'crowi-cli-clients-'));
    process.env.XDG_CONFIG_HOME = tmpRoot;
    delete process.env.CROWI_PROFILE;
    delete process.env.CROWI_URL;
    delete process.env.CROWI_TOKEN;
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    setRefreshHook(undefined);
    upsertProfile({ alias: 'work', endpoint: 'https://wiki.example.com', tokens: { accessToken: 'pat-1', scope: 'pages:write pages:read' } });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    if (ORIGINAL_XDG === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = ORIGINAL_XDG;
    }
    global.fetch = originalFetch;
    stderr.mockRestore();
    stdout.mockRestore();
    setRefreshHook(undefined);
    jest.restoreAllMocks();
  });

  function build(): Command {
    const program = new Command();
    program.exitOverride();
    program.option('-p, --profile <alias>').option('--url <baseUrl>').option('--token <accessToken>').option('--json').option('-q, --quiet');
    registerCreate(program);
    registerUpdate(program);
    registerEdit(program);
    registerGet(program);
    return program;
  }

  it('create and update advertise --type in --help', () => {
    const program = build();
    expect(findCommand(program, 'create').helpInformation()).toContain('--type <kind>');
    expect(findCommand(program, 'update').helpInformation()).toContain('--type <kind>');
  });

  describe('create --type / update --type validation (AC-CL-5)', () => {
    it.each(['create', 'update'])('%s --type bogus fails with EXIT.INVALID before any request', async (cmd) => {
      const args = cmd === 'create' ? ['create', '/a', '--type', 'bogus', '-m', 'x'] : ['update', '/a', '--type', 'bogus', '-m', 'x'];
      let caught: unknown;
      try {
        await build().parseAsync(args, { from: 'user' });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(CliError);
      expect((caught as CliError).exitCode).toBe(EXIT.INVALID);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('create --type artifact sends the header (AC-CL-5, and a regression for C-1b: create goes through postPage)', () => {
    it('sends X-Crowi-Page-Content-Type: artifact on the real POST /pages request', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1', path: '/a', revision: { _id: 'r1' } } }));

      await build().parseAsync(['create', '/a', '--type', 'artifact', '-m', '<html></html>'], { from: 'user' });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toContain('/api/pages');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['X-Crowi-Page-Content-Type']).toBe('artifact');
      expect(JSON.parse(init.body as string)).not.toHaveProperty('content_type');
    });
  });

  describe('create --file <html> without --type sends no header (AC-CL-6 — no inference from extension)', () => {
    it('does not infer artifact from a .html file extension', async () => {
      const file = join(tmpRoot, 'page.html');
      writeFileSync(file, '<html><body>hi</body></html>');
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1', path: '/a', revision: { _id: 'r1' } } }));

      await build().parseAsync(['create', '/a', '--file', file], { from: 'user' });

      const [, init] = fetchMock.mock.calls[0];
      expect((init.headers as Record<string, string> | undefined)?.['X-Crowi-Page-Content-Type']).toBeUndefined();
    });
  });

  describe('update --type artifact --force resends the header on the retry (AC-CL-5, C-2b)', () => {
    it('sends the header on both the initial PUT and the --force retry PUT', async () => {
      // fetchCurrentPage (GET), PUT (409), fetchCurrentPage retry (GET), PUT retry (200)
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1', path: '/a', revision: { _id: 'rev1', body: 'old' } } }))
        .mockResolvedValueOnce(jsonResponse(409, { error: { code: 'PAGE_REVISION_ERROR', message: 'stale' } }))
        .mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1', path: '/a', revision: { _id: 'rev2', body: 'old' } } }))
        .mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1', path: '/a', revision: { _id: 'rev3' } } }));

      await build().parseAsync(['update', '/a', '--type', 'artifact', '--force', '-m', '<html>v2</html>'], { from: 'user' });

      const putCalls = fetchMock.mock.calls.filter(([, init]) => init.method === 'PUT');
      expect(putCalls).toHaveLength(2);
      for (const [, init] of putCalls) {
        expect((init.headers as Record<string, string>)['X-Crowi-Page-Content-Type']).toBe('artifact');
      }
    });
  });

  describe('edit — temp file extension follows the CURRENT kind, and update omits --type (AC-CL-7)', () => {
    it('opens a .html temp file for an artifact page, and the save carries no content-type header (kind preserved)', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(200, {
            page: { _id: 'p1', path: '/a', contentType: 'artifact', revision: { _id: 'rev1', body: '<html>v1</html>', contentType: 'artifact' } },
          }),
        )
        .mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1', path: '/a', revision: { _id: 'rev2' } } }));

      const editSpy = jest.spyOn(editorModule, 'editInEditor').mockResolvedValue('<html>v2</html>');

      await build().parseAsync(['edit', '/a'], { from: 'user' });

      expect(editSpy).toHaveBeenCalledWith('<html>v1</html>', expect.any(String), 'html');
      const [, putInit] = fetchMock.mock.calls[1];
      expect((putInit.headers as Record<string, string> | undefined)?.['X-Crowi-Page-Content-Type']).toBeUndefined();
    });

    it('opens a .md temp file for a markdown page (existing behaviour unchanged)', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(200, { page: { _id: 'p1', path: '/a', contentType: 'markdown', revision: { _id: 'rev1', body: '# v1', contentType: 'markdown' } } }),
        )
        .mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1', path: '/a', revision: { _id: 'rev2' } } }));

      const editSpy = jest.spyOn(editorModule, 'editInEditor').mockResolvedValue('# v2');

      await build().parseAsync(['edit', '/a'], { from: 'user' });

      expect(editSpy).toHaveBeenCalledWith('# v1', expect.any(String), 'md');
    });
  });

  describe('get --json includes contentType; plain get prints the body only (AC-CL-8)', () => {
    it('includes contentType in --json output', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          page: { _id: 'p1', path: '/a', contentType: 'artifact', revision: { _id: 'rev1', body: '<html></html>', contentType: 'artifact' } },
        }),
      );

      await build().parseAsync(['--json', 'get', '/a'], { from: 'user' });

      const written = stdout.mock.calls.map((c) => String(c[0])).join('');
      const parsed = JSON.parse(written) as { contentType?: string; body?: string };
      expect(parsed.contentType).toBe('artifact');
      expect(parsed.body).toBe('<html></html>');
    });

    it('prints only the body for a plain (non --json) get', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          page: { _id: 'p1', path: '/a', contentType: 'artifact', revision: { _id: 'rev1', body: '<html>hi</html>', contentType: 'artifact' } },
        }),
      );

      await build().parseAsync(['get', '/a'], { from: 'user' });

      const written = stdout.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toBe('<html>hi</html>\n');
    });
  });
});
