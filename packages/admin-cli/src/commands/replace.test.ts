import { replaceExitCode } from './replace';

/**
 * Regression coverage for the `replace url` exit-code convention (mirrors
 * `rebuildExitCode`): a run that finished with >=1 failed page is a partial
 * success → exit 2, so an operator can detect it from a shell script; anything
 * else (full success / dry-run / declined) → exit 0. Fatal errors are exit 1
 * and handled in the action, never here.
 */
describe('replaceExitCode', () => {
  it('returns 2 when one or more pages failed (partial rewrite)', () => {
    expect(replaceExitCode({ failed: 1 })).toBe(2);
    expect(replaceExitCode({ failed: 9 })).toBe(2);
  });

  it('returns 0 on full success', () => {
    expect(replaceExitCode({ failed: 0 })).toBe(0);
  });
});
