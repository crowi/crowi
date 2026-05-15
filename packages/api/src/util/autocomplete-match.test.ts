import { classifyMatch, scoreCandidate } from './autocomplete-match';

/**
 * RFC-0004 Phase 5 — unit tests for autocomplete matching / scoring.
 *
 * Verifies the prefix > substring > fuzzy tiering and that field
 * weights break ties within a tier.
 */
describe('classifyMatch', () => {
  it('classifies a prefix match', () => {
    expect(classifyMatch('api-spec', 'api')).toBe('prefix');
  });

  it('classifies a substring match', () => {
    expect(classifyMatch('docs/api/spec', 'api')).toBe('substring');
  });

  it('classifies a fuzzy (subsequence) match', () => {
    expect(classifyMatch('api-spec', 'apc')).toBe('fuzzy');
  });

  it('returns null for no match', () => {
    expect(classifyMatch('api-spec', 'zzz')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(classifyMatch('API-Spec', 'api')).toBe('prefix');
  });

  it('returns null for an empty query', () => {
    expect(classifyMatch('api-spec', '')).toBeNull();
  });
});

describe('scoreCandidate', () => {
  it('ranks prefix above substring above fuzzy', () => {
    const prefix = scoreCandidate([{ text: 'api-spec', weight: 0 }], 'api');
    const substring = scoreCandidate([{ text: 'docs/api', weight: 0 }], 'api');
    const fuzzy = scoreCandidate([{ text: 'a-p-i-x', weight: 0 }], 'api');

    expect(prefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(fuzzy);
  });

  it('returns 0 when no field matches', () => {
    expect(scoreCandidate([{ text: 'api-spec', weight: 30 }], 'zzz')).toBe(0);
  });

  it('uses the best-scoring field', () => {
    // username prefix beats a name substring on the same candidate.
    const score = scoreCandidate(
      [
        { text: 'bob', weight: 30 },
        { text: 'Robert Bobson', weight: 20 },
      ],
      'bob',
    );
    // prefix tier (300) + username weight (30) + exact-match bonus (50).
    expect(score).toBe(380);
  });

  it('weights higher-weight fields above lower-weight ones in the same tier', () => {
    const usernamePrefix = scoreCandidate([{ text: 'apidev', weight: 30 }], 'api');
    const namePrefix = scoreCandidate([{ text: 'apidev', weight: 20 }], 'api');
    expect(usernamePrefix).toBeGreaterThan(namePrefix);
  });

  it('rewards an exact full-field prefix match over a longer prefix', () => {
    const exact = scoreCandidate([{ text: 'bob', weight: 30 }], 'bob');
    const longer = scoreCandidate([{ text: 'bobby', weight: 30 }], 'bob');
    expect(exact).toBeGreaterThan(longer);
  });
});
