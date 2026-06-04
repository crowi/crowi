import { isDuplicateKeyError, mapDuplicateKeyError } from './map-duplicate-key-error';

/**
 * feature-user-identity-uniqueness §d — E11000 → USERNAME_TAKEN / EMAIL_TAKEN
 * mapping. Pure unit tests over the error shapes the mongo driver raises.
 */

describe('mapDuplicateKeyError', () => {
  it('maps an email E11000 (keyPattern) to EMAIL_TAKEN', () => {
    const err = { code: 11000, keyPattern: { email: 1 }, keyValue: { email: 'a@b.com' }, message: 'E11000 dup key index: email_1' };
    expect(mapDuplicateKeyError(err)).toBe('EMAIL_TAKEN');
  });

  it('maps a username E11000 (keyPattern) to USERNAME_TAKEN', () => {
    const err = { code: 11000, keyPattern: { username: 1 }, keyValue: { username: 'bob' }, message: 'E11000 dup key index: username_1' };
    expect(mapDuplicateKeyError(err)).toBe('USERNAME_TAKEN');
  });

  it('falls back to the index name in the message when keyPattern is absent', () => {
    const emailErr = { code: 11000, message: 'E11000 duplicate key error collection: db.users index: email_1 dup key: { email: "a@b.com" }' };
    const usernameErr = { code: 11000, message: 'E11000 duplicate key error collection: db.users index: username_1 dup key: { username: "bob" }' };
    expect(mapDuplicateKeyError(emailErr)).toBe('EMAIL_TAKEN');
    expect(mapDuplicateKeyError(usernameErr)).toBe('USERNAME_TAKEN');
  });

  it('returns null for a non-E11000 error', () => {
    expect(mapDuplicateKeyError({ code: 121, message: 'document validation failed' })).toBeNull();
    expect(mapDuplicateKeyError(new Error('boom'))).toBeNull();
    expect(mapDuplicateKeyError(null)).toBeNull();
    expect(mapDuplicateKeyError(undefined)).toBeNull();
  });

  it('returns null for an E11000 on an unrelated index', () => {
    const err = { code: 11000, keyPattern: { googleId: 1 }, message: 'E11000 dup key index: googleId_1' };
    expect(mapDuplicateKeyError(err)).toBeNull();
  });

  it('isDuplicateKeyError distinguishes E11000 from other errors', () => {
    expect(isDuplicateKeyError({ code: 11000 })).toBe(true);
    expect(isDuplicateKeyError({ code: 121 })).toBe(false);
    expect(isDuplicateKeyError(new Error('x'))).toBe(false);
    expect(isDuplicateKeyError(null)).toBe(false);
  });
});
