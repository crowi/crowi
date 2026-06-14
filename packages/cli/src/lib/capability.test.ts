import { effectiveCapabilities, hasCapability, STATIC_CAPABILITIES } from './capability';

describe('capability detection', () => {
  it('treats the static baseline as always present, even with no advertised list', () => {
    const info = {};
    for (const cap of STATIC_CAPABILITIES) {
      expect(hasCapability(info, cap)).toBe(true);
    }
  });

  it('reports a dynamic capability only when the server advertises it', () => {
    expect(hasCapability({}, 'search')).toBe(false);
    expect(hasCapability({ capabilities: ['search'] }, 'search')).toBe(true);
  });

  it('unions the advertised list with the static baseline', () => {
    const set = effectiveCapabilities({ capabilities: ['search', 'collab'] });
    expect(set.has('search')).toBe(true);
    expect(set.has('collab')).toBe(true);
    // Static baseline still present.
    expect(set.has('pages')).toBe(true);
    expect(set.has('comments')).toBe(true);
  });

  it('does not invent capabilities the server omits', () => {
    expect(hasCapability({ capabilities: ['pages'] }, 'search')).toBe(false);
  });
});
