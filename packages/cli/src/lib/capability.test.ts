import { effectiveCapabilities, hasCapability, STATIC_CAPABILITIES, warnVersionSkew } from './capability';

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

describe('warnVersionSkew (WARN-ONLY policy)', () => {
  let stderr: jest.SpyInstance;

  beforeEach(() => {
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
  });

  it('warns when the server apiVersion differs from the CLI target', () => {
    warnVersionSkew({ apiVersion: 'v3' });
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0][0])).toContain('v3');
  });

  it('stays silent when the apiVersion matches', () => {
    warnVersionSkew({ apiVersion: 'v2' });
    expect(stderr).not.toHaveBeenCalled();
  });

  it('stays silent for an old server that omits apiVersion', () => {
    warnVersionSkew({});
    warnVersionSkew({ version: '2.0.0' });
    expect(stderr).not.toHaveBeenCalled();
  });
});
