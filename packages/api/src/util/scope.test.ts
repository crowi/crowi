import { ALL_SCOPES, SCOPES, parseScopeClaim, scopeSatisfies } from '@crowi/api-contract';

/**
 * RFC-0010 Phase 1 — unit tests for the scope implication rules
 * (`scopeSatisfies`) and the `scope` claim parser. Pure functions, no
 * DB / Hono — the integration behaviour (403 / passthrough) is covered
 * by `hono/middleware/require-scope.test.ts`.
 */
describe('scopeSatisfies', () => {
  describe('direct grant', () => {
    it('passes when the required scope is granted verbatim', () => {
      expect(scopeSatisfies('pages:read', new Set(['pages:read']))).toBe(true);
      expect(scopeSatisfies('pages:write', new Set(['pages:write']))).toBe(true);
    });

    it('fails when the required scope is absent', () => {
      expect(scopeSatisfies('pages:write', new Set(['comments:write']))).toBe(false);
      expect(scopeSatisfies('pages:read', new Set([]))).toBe(false);
    });
  });

  describe('write implies same-resource read', () => {
    it('a write grant satisfies the matching read requirement', () => {
      expect(scopeSatisfies('pages:read', new Set(['pages:write']))).toBe(true);
      expect(scopeSatisfies('comments:read', new Set(['comments:write']))).toBe(true);
      expect(scopeSatisfies('attachments:read', new Set(['attachments:write']))).toBe(true);
    });

    it('a write grant does NOT satisfy another resource read', () => {
      expect(scopeSatisfies('comments:read', new Set(['pages:write']))).toBe(false);
    });

    it('a read grant does NOT satisfy a write requirement', () => {
      expect(scopeSatisfies('pages:write', new Set(['pages:read']))).toBe(false);
    });
  });

  describe('umbrella read', () => {
    it('satisfies any resource read', () => {
      expect(scopeSatisfies('pages:read', new Set(['read']))).toBe(true);
      expect(scopeSatisfies('comments:read', new Set(['read']))).toBe(true);
      expect(scopeSatisfies('profile:read', new Set(['read']))).toBe(true);
    });

    it('does NOT satisfy any resource write', () => {
      expect(scopeSatisfies('pages:write', new Set(['read']))).toBe(false);
      expect(scopeSatisfies('comments:write', new Set(['read']))).toBe(false);
    });
  });

  describe('umbrella write', () => {
    it('satisfies any resource write', () => {
      expect(scopeSatisfies('pages:write', new Set(['write']))).toBe(true);
      expect(scopeSatisfies('attachments:write', new Set(['write']))).toBe(true);
    });

    it('also satisfies any resource read (write implies read)', () => {
      expect(scopeSatisfies('pages:read', new Set(['write']))).toBe(true);
      expect(scopeSatisfies('notifications:read', new Set(['write']))).toBe(true);
    });
  });

  describe('ALL_SCOPES (web session)', () => {
    it('satisfies every catalog scope', () => {
      for (const scope of SCOPES) {
        expect(scopeSatisfies(scope, ALL_SCOPES)).toBe(true);
      }
    });
  });

  describe('umbrella requirements', () => {
    it('a bare `read` / `write` requirement needs a direct grant', () => {
      expect(scopeSatisfies('read', new Set(['pages:read']))).toBe(false);
      expect(scopeSatisfies('read', new Set(['read']))).toBe(true);
      expect(scopeSatisfies('write', new Set(['write']))).toBe(true);
    });
  });
});

describe('parseScopeClaim', () => {
  it('splits a space-delimited claim into known scopes', () => {
    const parsed = parseScopeClaim('pages:read pages:write comments:read');
    expect(parsed).toEqual(new Set(['pages:read', 'pages:write', 'comments:read']));
  });

  it('drops unknown tokens', () => {
    const parsed = parseScopeClaim('pages:read totally:bogus write');
    expect(parsed).toEqual(new Set(['pages:read', 'write']));
  });

  it('tolerates extra / leading / trailing whitespace', () => {
    const parsed = parseScopeClaim('  pages:read   comments:write  ');
    expect(parsed).toEqual(new Set(['pages:read', 'comments:write']));
  });

  it('returns an empty set for empty / nullish input', () => {
    expect(parseScopeClaim('')).toEqual(new Set());
    expect(parseScopeClaim(undefined)).toEqual(new Set());
    expect(parseScopeClaim(null)).toEqual(new Set());
  });
});
