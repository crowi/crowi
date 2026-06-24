import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { observeYTextUntil } from './observe-ytext-until';

const YJS_DOUBLE_REMOVE = "[yjs] Tried to remove event handler that doesn't exist.";

describe('observeYTextUntil', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does NOT double-unobserve when the observer self-stops and cleanup later runs (the new-page yjs warning)', () => {
    // Reproduces the editor auto-focus flow: the seeded body arrives via a
    // sync delta AFTER mount, the predicate completes inside the observer
    // (self-stop), and then the effect re-runs / unmounts → cleanup. The
    // cleanup must be a no-op here, not a second unobserve.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const doc = new Y.Doc();
    const yText = doc.getText('content');

    const cleanup = observeYTextUntil(yText, () => yText.length > 0);

    // Content seeds after mount → observer fires → predicate true → self-stop.
    yText.insert(0, '# title\n\n');
    // Effect re-run (isWide settles) / unmount → cleanup runs after self-stop.
    cleanup();

    expect(errorSpy).not.toHaveBeenCalledWith(YJS_DOUBLE_REMOVE);
  });

  it('invokes the predicate immediately and never observes when already satisfied (warm session)', () => {
    const doc = new Y.Doc();
    const yText = doc.getText('content');
    yText.insert(0, 'already here');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    let calls = 0;
    const cleanup = observeYTextUntil(yText, () => {
      calls++;
      return yText.length > 0;
    });
    cleanup(); // must be a safe no-op (nothing was observed)

    expect(calls).toBe(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('unobserves exactly once when cleanup runs before the predicate completes', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const doc = new Y.Doc();
    const yText = doc.getText('content');

    let calls = 0;
    const cleanup = observeYTextUntil(yText, () => {
      calls++;
      return yText.length > 0;
    });
    cleanup(); // unmount before any content → single unobserve

    // Observer is gone: a later mutation must not re-run the predicate.
    yText.insert(0, 'late');

    expect(calls).toBe(1); // only the immediate check, never the observer
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('keeps firing the predicate until it returns true, then stops', () => {
    const doc = new Y.Doc();
    const yText = doc.getText('content');
    const seen: number[] = [];
    let done = false;

    const cleanup = observeYTextUntil(yText, () => {
      seen.push(yText.length);
      done = yText.length >= 3;
      return done;
    });

    yText.insert(0, 'a'); // len 1 → not done
    yText.insert(1, 'b'); // len 2 → not done
    yText.insert(2, 'c'); // len 3 → done → self-stop
    yText.insert(3, 'd'); // observer already removed → no further call

    cleanup();
    expect(done).toBe(true);
    expect(seen).toEqual([0, 1, 2, 3]); // immediate(0) + three deltas, none after stop
  });
});
