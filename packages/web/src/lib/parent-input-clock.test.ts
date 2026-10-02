import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installParentInputClock, isParentInputQuiet, PARENT_INPUT_QUARANTINE_MS, resetParentInputClockForTest } from './parent-input-clock';

const INPUT_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'keydown', 'keyup', 'touchstart', 'touchend', 'click'] as const;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['performance'] });
});

afterEach(() => {
  resetParentInputClockForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('isParentInputQuiet', () => {
  it('is false before the clock is installed', () => {
    expect(isParentInputQuiet()).toBe(false);
  });

  it('is true right after install when no input has been seen', () => {
    installParentInputClock();
    expect(isParentInputQuiet()).toBe(true);
  });

  it.each(INPUT_EVENTS)('is false right after a trusted %s and true again once the quarantine has passed', (type) => {
    installParentInputClock({ trust: () => true });
    window.dispatchEvent(new Event(type));
    expect(isParentInputQuiet()).toBe(false);
    vi.advanceTimersByTime(PARENT_INPUT_QUARANTINE_MS - 1);
    expect(isParentInputQuiet()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(isParentInputQuiet()).toBe(true);
  });

  it('measures from the latest input', () => {
    installParentInputClock({ trust: () => true });
    window.dispatchEvent(new Event('keydown'));
    vi.advanceTimersByTime(PARENT_INPUT_QUARANTINE_MS - 1000);
    window.dispatchEvent(new Event('keyup'));
    vi.advanceTimersByTime(1000);
    expect(isParentInputQuiet()).toBe(false);
  });

  it('accepts an explicit time', () => {
    installParentInputClock({ trust: () => true });
    window.dispatchEvent(new Event('click'));
    const now = performance.now();
    expect(isParentInputQuiet(now + PARENT_INPUT_QUARANTINE_MS - 1)).toBe(false);
    expect(isParentInputQuiet(now + PARENT_INPUT_QUARANTINE_MS)).toBe(true);
  });
});

describe('installParentInputClock', () => {
  it('ignores untrusted events by default, which is every event jsdom dispatches', () => {
    installParentInputClock();
    for (const type of INPUT_EVENTS) document.body.dispatchEvent(new Event(type, { bubbles: true }));
    expect(isParentInputQuiet()).toBe(true);
  });

  it('records input whose propagation a handler in the page stops', () => {
    installParentInputClock({ trust: () => true });
    const child = document.body.appendChild(document.createElement('button'));
    child.addEventListener('click', (event) => event.stopPropagation());
    child.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(isParentInputQuiet()).toBe(false);
    child.remove();
  });

  it('records input that does not bubble', () => {
    installParentInputClock({ trust: () => true });
    const child = document.body.appendChild(document.createElement('div'));
    child.dispatchEvent(new Event('pointerdown', { bubbles: false }));
    expect(isParentInputQuiet()).toBe(false);
    child.remove();
  });

  it('registers capture-phase passive listeners on window, once however often it is called', () => {
    const add = vi.spyOn(window, 'addEventListener');
    installParentInputClock();
    installParentInputClock();
    installParentInputClock({ trust: () => true });
    expect(add).toHaveBeenCalledTimes(INPUT_EVENTS.length);
    for (const [index, type] of INPUT_EVENTS.entries()) {
      expect(add.mock.calls[index]?.[0]).toBe(type);
      expect(add.mock.calls[index]?.[2]).toEqual({ capture: true, passive: true });
    }
    // The first install's default trust is kept, so the later override changes nothing.
    window.dispatchEvent(new Event('click'));
    expect(isParentInputQuiet()).toBe(true);
  });

  it('is fully undone by the test reset', () => {
    installParentInputClock({ trust: () => true });
    window.dispatchEvent(new Event('click'));
    resetParentInputClockForTest();
    expect(isParentInputQuiet()).toBe(false);
    installParentInputClock();
    expect(isParentInputQuiet()).toBe(true);
  });
});
