import { Command } from 'commander';

import { createProgram } from '../cli';
import { isNoSkewProbe, markNoSkewProbe } from './skew';

/**
 * FIX 9: the version-skew probe opt-out is tied to the Command OBJECT via a
 * typed WeakSet (markNoSkewProbe) instead of a hand-maintained name set, so a
 * newly-added command defaults to "probe" and can't silently inherit the
 * wrong behavior. These tests lock the helper and the wiring: the local /
 * pre-auth commands opt out, and an authenticated page command does NOT.
 */
describe('markNoSkewProbe / isNoSkewProbe helper', () => {
  it('marks only the commands passed to it', () => {
    const a = new Command('a');
    const b = new Command('b');
    markNoSkewProbe(a);
    expect(isNoSkewProbe(a)).toBe(true);
    // An unmarked command defaults to "probe" (membership false).
    expect(isNoSkewProbe(b)).toBe(false);
  });

  it('returns the same command (chainable)', () => {
    const cmd = new Command('c');
    expect(markNoSkewProbe(cmd)).toBe(cmd);
  });
});

describe('createProgram skew opt-out wiring', () => {
  const program = createProgram();
  const byName = (name: string): Command => {
    const found = program.commands.find((c) => c.name() === name);
    if (!found) throw new Error(`command not registered: ${name}`);
    return found;
  };

  it.each(['login', 'logout', 'profiles', 'open', 'completion'])('opts %s out of the skew probe (local / pre-auth)', (name) => {
    expect(isNoSkewProbe(byName(name))).toBe(true);
  });

  it.each(['search', 'whoami', 'mv', 'comment', 'attach', 'bookmark'])('keeps %s ON the skew probe (authenticated surface)', (name) => {
    // comment / attach / bookmark must NOT opt out — with the ensureCapability
    // pre-flight removed (FIX 10) the hook is now their single skew source.
    expect(isNoSkewProbe(byName(name))).toBe(false);
  });
});
