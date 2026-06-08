import { describe, it, expect } from 'vitest';
import { isNetworkError, isTimeoutAbort } from './is-network-error';
import { TIMEOUT_ABORT_REASON } from './fetch-timeout';

/** Build an AbortError-shaped object with an optional `reason`. */
function abortError(reason?: unknown): Error & { reason?: unknown } {
  const err = new Error('The operation was aborted') as Error & { reason?: unknown };
  err.name = 'AbortError';
  if (reason !== undefined) err.reason = reason;
  return err;
}

describe('isNetworkError', () => {
  it('classifies a fetch "Failed to fetch" TypeError as a network error', () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('classifies TypeErrors mentioning network/connection', () => {
    expect(isNetworkError(new TypeError('NetworkError when attempting to fetch resource'))).toBe(true);
    expect(isNetworkError(new TypeError('Connection refused'))).toBe(true);
  });

  it('classifies a timeout-reason AbortError as a network error', () => {
    expect(isNetworkError(abortError(TIMEOUT_ABORT_REASON))).toBe(true);
  });

  it('does NOT classify a user/react-query cancel AbortError as a network error', () => {
    // No reason, or a non-timeout reason → deliberate cancel, not an outage.
    expect(isNetworkError(abortError())).toBe(false);
    expect(isNetworkError(abortError('user-cancel'))).toBe(false);
  });

  it('does NOT classify ordinary application errors as network errors', () => {
    expect(isNetworkError(new Error('Failed to fetch page list'))).toBe(false);
    expect(isNetworkError({ status: 500 })).toBe(false);
    expect(isNetworkError(null)).toBe(false);
  });
});

describe('isTimeoutAbort', () => {
  it('recognises the bare sentinel reason thrown directly', () => {
    expect(isTimeoutAbort(TIMEOUT_ABORT_REASON)).toBe(true);
  });

  it('recognises an AbortError whose reason is the sentinel', () => {
    expect(isTimeoutAbort(abortError(TIMEOUT_ABORT_REASON))).toBe(true);
  });

  it('rejects non-timeout aborts and other errors', () => {
    expect(isTimeoutAbort(abortError())).toBe(false);
    expect(isTimeoutAbort(abortError('user-cancel'))).toBe(false);
    expect(isTimeoutAbort(new TypeError('Failed to fetch'))).toBe(false);
  });
});
