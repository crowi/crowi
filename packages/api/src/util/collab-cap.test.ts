import type Crowi from 'src/crowi';
import { checkEditorCap, _setEditorCapCounterForTesting } from './collab-cap';
import type { EditorCapCounter } from './editor-cap-counter';

/**
 * RFC-0003 Phase 6 — promotes the Phase 2 stub to a Redis-backed
 * check. These unit tests cover the `checkEditorCap` thin wrapper
 * without booting Redis: we inject a synthetic `EditorCapCounter`
 * through `_setEditorCapCounterForTesting` and assert the
 * peek-then-compare logic.
 */

const makeCounter = (count: number, cap: number): EditorCapCounter => ({
  maxEditorsPerPage: cap,
  async peek() {
    return { count, cap };
  },
  async tryAcquire() {
    return { acquired: count < cap, count, cap };
  },
  async release() {
    /* nothing */
  },
  async disconnect() {
    /* nothing */
  },
});

/**
 * `checkEditorCap` now takes a Crowi instance so the lazy counter
 * factory can read `crowi.redis`. When a fake counter is injected
 * via `_setEditorCapCounterForTesting` we never touch the Crowi
 * surface, so a minimal stub satisfies the type.
 */
const stubCrowi = {} as Crowi;

describe('checkEditorCap', () => {
  afterEach(() => {
    _setEditorCapCounterForTesting(null);
  });

  test('returns readonly:false when the page is below the cap', async () => {
    _setEditorCapCounterForTesting(makeCounter(5, 20));
    await expect(checkEditorCap(stubCrowi, 'any-page')).resolves.toEqual({ readonly: false });
  });

  test('returns readonly:false when the page is exactly one below the cap', async () => {
    _setEditorCapCounterForTesting(makeCounter(19, 20));
    await expect(checkEditorCap(stubCrowi, 'any-page')).resolves.toEqual({ readonly: false });
  });

  test('returns readonly:true when the page is at the cap', async () => {
    _setEditorCapCounterForTesting(makeCounter(20, 20));
    await expect(checkEditorCap(stubCrowi, 'any-page')).resolves.toEqual({ readonly: true });
  });

  test('returns readonly:true when the page is above the cap (race overshoot)', async () => {
    _setEditorCapCounterForTesting(makeCounter(22, 20));
    await expect(checkEditorCap(stubCrowi, 'any-page')).resolves.toEqual({ readonly: true });
  });

  test('returns readonly:false when the counter has degraded to no-op (fail-open)', async () => {
    // A degraded counter (Redis unconfigured / unreachable) reports
    // peek()=0 — callers must not be locked out by a Redis outage.
    _setEditorCapCounterForTesting(makeCounter(0, 20));
    await expect(checkEditorCap(stubCrowi, 'any-page')).resolves.toEqual({ readonly: false });
  });
});
