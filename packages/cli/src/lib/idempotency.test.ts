import { IDEMPOTENCY_KEY_PATTERN } from '@crowi/api-contract';

import { newIdempotencyKey } from './idempotency';

/**
 * The pattern is imported from `@crowi/api-contract` rather than copied here
 * — the CLI must stay byte-for-byte in sync with whatever the server
 * actually enforces, with no second copy of the regex to drift.
 */
describe('newIdempotencyKey', () => {
  it('generates a fresh contract-conforming key on every call', () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();

    expect(a).toMatch(IDEMPOTENCY_KEY_PATTERN);
    expect(b).toMatch(IDEMPOTENCY_KEY_PATTERN);
    expect(a).not.toBe(b);
  });
});
