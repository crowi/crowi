import { EXIT } from './lib/http';

const parseAsync = jest.fn();

jest.mock('./cli', () => ({ createProgram: () => ({ parseAsync }) }));

/**
 * bin.ts runs at import time, so each case loads it afresh with a rejecting
 * program and a stubbed process.exit / stderr.
 */
describe('bin — artifact rejection output (AC-AAG-7)', () => {
  const originalArgv = process.argv;
  let stderr: jest.SpyInstance;
  let stdout: jest.SpyInstance;
  let exit: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    parseAsync.mockReset();
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    process.argv = originalArgv;
    jest.restoreAllMocks();
  });

  const message = 'fixed guidance (AI-R11 / EXTERNAL_REFERENCE) [diagnostic: PAGE_LINK_QUERY]\ntarget: a[href]';

  it.each([[[]], [['--json']], [['--quiet']]])('writes the diagnostic once to stderr and exits 6 (flags %p)', async (flags) => {
    process.argv = ['node', 'crowi', ...flags, 'create', '/a'];

    jest.isolateModules(() => {
      // bin.ts's instanceof check must see the same CliError class, so build it inside the isolated registry.
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const { CliError } = require('./lib/http') as typeof import('./lib/http');
      parseAsync.mockRejectedValueOnce(new CliError(message, { exitCode: EXIT.INVALID, apiCode: 'ARTIFACT_WRITE_REJECTED' }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('./bin');
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(`crowi: ${message}\n`);
    expect(stdout).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(EXIT.INVALID);
    expect(EXIT.INVALID).toBe(6);
  });
});
