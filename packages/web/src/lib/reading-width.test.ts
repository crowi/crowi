import { afterEach, describe, expect, it } from 'vitest';
import { READING_WIDTH_ATTRIBUTE, READING_WIDTH_STORAGE_KEY, parseReadingWidth, readingWidthBootstrapScript } from './reading-width';

afterEach(() => {
  document.documentElement.removeAttribute(READING_WIDTH_ATTRIBUTE);
  window.localStorage.clear();
});

/** Runs the real generated script against the jsdom document, with `getItem` optionally replaced. */
function runBootstrap(getItem?: (key: string) => string | null): string | null {
  const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
  if (getItem) Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem } });
  try {
    new Function(readingWidthBootstrapScript())();
  } finally {
    if (original) Object.defineProperty(window, 'localStorage', original);
  }
  return document.documentElement.getAttribute(READING_WIDTH_ATTRIBUTE);
}

describe('reading width bootstrap', () => {
  it('keeps the storage key fixed', () => {
    expect(READING_WIDTH_STORAGE_KEY).toBe('crowi:reading-width:v1');
  });

  it.each([
    ['full', 'full'],
    ['standard', 'standard'],
    ['', 'standard'],
    [null, 'standard'],
    ['FULL', 'standard'],
    ['wide', 'standard'],
  ] as const)('parses %j as %s', (stored, expected) => {
    expect(parseReadingWidth(stored)).toBe(expected);
  });

  it.each([
    ['full', 'full'],
    ['standard', 'standard'],
    ['', 'standard'],
    ['unknown', 'standard'],
  ] as const)('the script sets the attribute for a stored %j to %s', (stored, expected) => {
    window.localStorage.setItem(READING_WIDTH_STORAGE_KEY, stored);
    expect(runBootstrap()).toBe(expected);
  });

  it('the script leaves an unset preference as the standard width', () => {
    expect(runBootstrap()).toBe('standard');
  });

  it('the script falls back to standard when reading storage throws, without throwing itself', () => {
    expect(
      runBootstrap(() => {
        throw new DOMException('blocked', 'SecurityError');
      }),
    ).toBe('standard');
  });

  it('never writes storage and embeds no stored value', () => {
    const script = readingWidthBootstrapScript();
    expect(script).not.toContain('setItem');
    expect(script).toContain(READING_WIDTH_STORAGE_KEY);
  });
});
