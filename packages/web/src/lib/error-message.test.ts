import { describe, it, expect } from 'vitest';
import { ERROR_CODES } from '@crowi/api-contract';
import { overwriteGetLocale } from '@paraglide/runtime.js';
import { ERROR_MESSAGE_KEYS, errorMessage } from './error-message';

describe('errorMessage', () => {
  it('maps a known code to its localized message (en)', () => {
    overwriteGetLocale(() => 'en');
    expect(errorMessage('EMAIL_TAKEN')).toBe('This email address is already in use.');
  });

  it('switches the message when the locale changes (ja)', () => {
    overwriteGetLocale(() => 'ja');
    expect(errorMessage('EMAIL_TAKEN')).toBe('そのメールアドレスは既に使われています。');
  });

  it('falls back to the server message for an unknown code', () => {
    overwriteGetLocale(() => 'en');
    expect(errorMessage('SOMETHING_NEW', 'Server said no')).toBe('Server said no');
  });

  it('falls back to a generic message when code and fallback are both absent', () => {
    overwriteGetLocale(() => 'en');
    expect(errorMessage(undefined)).toBe('An unexpected error occurred.');
    overwriteGetLocale(() => 'ja');
    expect(errorMessage(undefined)).toBe('予期しないエラーが発生しました。');
  });

  it('prefers the localized message over the fallback for a known code', () => {
    overwriteGetLocale(() => 'en');
    // Even with a (stale) server message, a recognised code wins.
    expect(errorMessage('PAGE_NOT_FOUND', 'raw english from server')).toBe('Page not found.');
  });

  it('distinguishes the page-transition 409s from the revision-conflict 409', () => {
    // All three arrive as 409, so the code is the only thing telling a reader
    // "your edit raced another edit" from "the page itself is being moved".
    // Collapsing any two onto one message would hide that difference.
    overwriteGetLocale(() => 'en');
    const revisionConflict = errorMessage('PAGE_REVISION_ERROR');
    const inProgress = errorMessage('PAGE_TRANSITION_IN_PROGRESS');
    const keyConflict = errorMessage('IDEMPOTENCY_KEY_CONFLICT');
    expect(new Set([revisionConflict, inProgress, keyConflict]).size).toBe(3);
  });

  it('has an exhaustive mapping covering every ErrorCode', () => {
    // ERROR_MESSAGE_KEYS is typed `satisfies Record<ErrorCode, …>` so a gap
    // is already a compile error; this asserts it at runtime too as a guard
    // against the map being widened by accident.
    for (const code of ERROR_CODES) {
      expect(ERROR_MESSAGE_KEYS).toHaveProperty(code);
    }
    expect(Object.keys(ERROR_MESSAGE_KEYS).sort()).toEqual([...ERROR_CODES].sort());
  });
});
