import { CliError, EXIT } from '../lib/http';
import { rethrowNewerEndpointHint, rethrowScopeHint } from './_shared';

/**
 * The re-throw helpers translate a raw API failure into an actionable hint.
 * `rethrowScopeHint` covers the "your token lacks a scope" case; the newer
 * sibling `rethrowNewerEndpointHint` degrades a 404 on an above-floor route
 * (RFC-0012 §3.4) into a "needs a newer Crowi" message.
 */

describe('rethrowNewerEndpointHint (degrade-on-404)', () => {
  it('maps a 404 to a "needs a newer Crowi" hint naming the command', () => {
    const err = new CliError('not found', { status: 404, exitCode: EXIT.NOT_FOUND });
    expect(() => rethrowNewerEndpointHint(err, 'mv (folder/subtree)')).toThrow(CliError);
    try {
      rethrowNewerEndpointHint(err, 'mv (folder/subtree)');
    } catch (caught) {
      expect(caught).toBeInstanceOf(CliError);
      const e = caught as CliError;
      expect(e.message).toContain('may not support `mv (folder/subtree)`');
      expect(e.message).toContain('newer Crowi version');
      expect(e.exitCode).toBe(EXIT.NOT_FOUND);
      expect(e.status).toBe(404);
    }
  });

  it('re-throws non-404 CliErrors unchanged', () => {
    const err = new CliError('conflict', { status: 409, exitCode: EXIT.CONFLICT });
    expect(() => rethrowNewerEndpointHint(err, 'mv')).toThrow(err);
  });

  it('re-throws non-CliError values unchanged', () => {
    const err = new Error('boom');
    expect(() => rethrowNewerEndpointHint(err, 'mv')).toThrow(err);
  });
});

describe('rethrowScopeHint (regression guard)', () => {
  it('maps a 403 to a re-login-with-scope hint', () => {
    const err = new CliError('forbidden', { status: 403 });
    expect(() => rethrowScopeHint(err, 'comments:write')).toThrow(/--scope "comments:write"/);
  });
});
