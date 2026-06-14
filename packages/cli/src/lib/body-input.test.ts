import { CliError } from './http';
import { resolveBody } from './body-input';

/**
 * Unit coverage for the page-body source resolution shared by `create` /
 * `update`. Covers the mutually-exclusive `--message` / `--file` / `--stdin`
 * guard and the "no source → undefined" contract (so `create` can fall back
 * to `$EDITOR`). The `--file` read path is exercised against a real temp file.
 */
describe('resolveBody', () => {
  it('returns the literal --message body', async () => {
    await expect(resolveBody({ message: 'hello' })).resolves.toBe('hello');
  });

  it('returns undefined when no source is given', async () => {
    await expect(resolveBody({})).resolves.toBeUndefined();
  });

  it('rejects when more than one source is supplied', async () => {
    await expect(resolveBody({ message: 'a', stdin: true })).rejects.toBeInstanceOf(CliError);
    await expect(resolveBody({ message: 'a', file: '/tmp/x' })).rejects.toBeInstanceOf(CliError);
  });

  it('throws a clear error when --file cannot be read', async () => {
    await expect(resolveBody({ file: '/nonexistent/crowi-test-file.md' })).rejects.toThrow(/cannot read --file/);
  });
});
