import { markEditing } from './presence';

describe('presence.markEditing (RFC-0003 Phase 5 stub)', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('resolves without throwing for valid args (no-op)', async () => {
    await expect(markEditing('page-id', 'user-id')).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('parallel calls are safe (no shared mutable state)', async () => {
    await expect(Promise.all([markEditing('p1', 'u1'), markEditing('p1', 'u2'), markEditing('p2', 'u1')])).resolves.toEqual([undefined, undefined, undefined]);
  });

  test('empty pageId surfaces a warning but does not throw', async () => {
    await expect(markEditing('', 'user-id')).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test('empty userId surfaces a warning but does not throw', async () => {
    await expect(markEditing('page-id', '')).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
