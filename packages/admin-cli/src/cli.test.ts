import { createProgram } from './cli';

/**
 * feature-admin-cli-quiet-output: `createProgram()` runs before any
 * subcommand action (both `bin.ts` and `pnpm migrate` call it via
 * `dist/bin.js`, and it fully returns before `.parseAsync()` starts), so
 * setting `process.noDeprecation` here — instead of a `node` flag on one
 * invocation path — suppresses Node's own DeprecationWarning (e.g. DEP0169
 * from a transitive dep's `url.parse()` call) regardless of how the CLI is
 * invoked, on every command, dev and prod alike.
 */
describe('createProgram (feature-admin-cli-quiet-output)', () => {
  const originalNoDeprecation = process.noDeprecation;

  afterEach(() => {
    process.noDeprecation = originalNoDeprecation;
  });

  it('sets process.noDeprecation so Node DeprecationWarnings never reach the operator', () => {
    process.noDeprecation = false;
    createProgram();
    expect(process.noDeprecation).toBe(true);
  });

  it('still builds a usable commander program (name/description unaffected)', () => {
    const program = createProgram();
    expect(program.name()).toBe('crowi-admin');
  });
});
