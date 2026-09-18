import { formatArtifactRejection } from './artifact-rejection';

/**
 * RFC-0020 §J-1 — `formatArtifactRejection` is the SOLE place the CLI turns
 * a rejection envelope into a message.
 * `lib/http.ts#parseResponse` is the only caller; these tests exercise the
 * pure function directly.
 */
describe('formatArtifactRejection', () => {
  it('formats a complete envelope with a target as "<message> (<ruleId> / <reason>)\\ntarget: <target>"', () => {
    const body = {
      error: {
        code: 'ARTIFACT_WRITE_REJECTED',
        reason: 'SCRIPT_TYPE_FORBIDDEN',
        ruleId: 'AI-R13',
        message: 'This script type is not allowed in an artifact page.',
        target: 'script[type]',
      },
    };
    expect(formatArtifactRejection(body)).toBe('This script type is not allowed in an artifact page. (AI-R13 / SCRIPT_TYPE_FORBIDDEN)\ntarget: script[type]');
  });

  it('formats a complete envelope with no target as a single line, and omits a trailing "target:" (a 1-line vs 2-line shape difference)', () => {
    const body = {
      error: {
        code: 'ARTIFACT_WRITE_REJECTED',
        reason: 'ARTIFACT_DELIVERY_NOT_CONFIGURED',
        ruleId: 'AI-D03',
        message: 'Artifact delivery is not configured on this server.',
      },
    };
    const formatted = formatArtifactRejection(body);
    expect(formatted).toBe('Artifact delivery is not configured on this server. (AI-D03 / ARTIFACT_DELIVERY_NOT_CONFIGURED)');
    expect(formatted).not.toContain('\n');
    expect(formatted).not.toContain('target:');
  });

  it('returns null for an ordinary (non-artifact) Crowi error envelope', () => {
    expect(formatArtifactRejection({ error: { code: 'PAGE_NOT_FOUND', message: 'Page not found.' } })).toBeNull();
  });

  it('returns null for a partial/lookalike envelope carrying only `code` (a front proxy could produce this) rather than rendering "undefined (undefined / undefined)"', () => {
    expect(formatArtifactRejection({ error: { code: 'ARTIFACT_WRITE_REJECTED' } })).toBeNull();
  });

  it('returns null when the body is undefined/absent', () => {
    expect(formatArtifactRejection(undefined)).toBeNull();
  });

  it('returns null for a non-object body (e.g. a raw string from a non-JSON error page)', () => {
    expect(formatArtifactRejection('<html>proxy error</html>')).toBeNull();
  });

  it('never surfaces extra body/token/secret fields the server response happens to carry alongside a complete envelope', () => {
    const secretToken = 'crowi_pat_should-not-leak-into-formatted-output';
    const body = {
      error: {
        code: 'ARTIFACT_WRITE_REJECTED',
        reason: 'SCRIPT_TYPE_FORBIDDEN',
        ruleId: 'AI-R13',
        message: 'This script type is not allowed in an artifact page.',
        target: 'script[type]',
        // Fields no real server response includes, but the formatter must
        // not echo even if a future response (or a misbehaving proxy) adds
        // them — it only ever reads message/ruleId/reason/target.
        body: '<!doctype html><script>document.cookie</script>',
        token: secretToken,
        secret: 'top-secret-app-secret-value',
      },
      // A sibling top-level field, same reasoning.
      token: secretToken,
    };
    const formatted = formatArtifactRejection(body);
    expect(formatted).toBe('This script type is not allowed in an artifact page. (AI-R13 / SCRIPT_TYPE_FORBIDDEN)\ntarget: script[type]');
    expect(formatted).not.toContain(secretToken);
    expect(formatted).not.toContain('top-secret-app-secret-value');
    expect(formatted).not.toContain('<script>');
  });
});
