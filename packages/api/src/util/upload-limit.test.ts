import { resolveUploadMaxBytes, UPLOAD_MAX_BYTES_CEILING, UPLOAD_MAX_BYTES_DEFAULT } from './upload-limit';

/**
 * AC-2/AC-3/AC-4: `resolveUploadMaxBytes` is the sole place
 * `CROWI_UPLOAD_MAX_BYTES` is parsed.
 */
describe('resolveUploadMaxBytes', () => {
  it('AC-4: falls back to the default (50 MB) when unset', () => {
    expect(resolveUploadMaxBytes(undefined)).toBe(UPLOAD_MAX_BYTES_DEFAULT);
    expect(UPLOAD_MAX_BYTES_DEFAULT).toBe(50 * 1024 * 1024);
  });

  it('AC-2: a value below the ceiling is used as-is', () => {
    expect(resolveUploadMaxBytes('1048576')).toBe(1024 * 1024);
  });

  it('AC-2: a value exactly at the ceiling is used as-is, with no warning', () => {
    const warn = jest.fn();
    expect(resolveUploadMaxBytes(String(UPLOAD_MAX_BYTES_CEILING), warn)).toBe(UPLOAD_MAX_BYTES_CEILING);
    expect(warn).not.toHaveBeenCalled();
  });

  it('AC-3: a value above the ceiling is rounded down to the ceiling and warns once', () => {
    const warn = jest.fn();
    const result = resolveUploadMaxBytes(String(UPLOAD_MAX_BYTES_CEILING + 1), warn);
    expect(result).toBe(UPLOAD_MAX_BYTES_CEILING);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(String(UPLOAD_MAX_BYTES_CEILING + 1));
    expect(warn.mock.calls[0][0]).toContain(String(UPLOAD_MAX_BYTES_CEILING));
  });

  it('AC-3: a far-above-ceiling value also warns and clamps', () => {
    const warn = jest.fn();
    expect(resolveUploadMaxBytes('999999999999', warn)).toBe(UPLOAD_MAX_BYTES_CEILING);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('AC-3: a value beyond Number.MAX_SAFE_INTEGER still clamps, and the warning echoes the raw digits the operator typed rather than a precision-lossy parsed number', () => {
    const warn = jest.fn();
    const raw = '999999999999999999999999';
    expect(resolveUploadMaxBytes(raw, warn)).toBe(UPLOAD_MAX_BYTES_CEILING);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(raw);
  });

  it('AC-4: a non-numeric value falls back to the default', () => {
    const warn = jest.fn();
    expect(resolveUploadMaxBytes('not-a-number', warn)).toBe(UPLOAD_MAX_BYTES_DEFAULT);
    expect(warn).not.toHaveBeenCalled();
  });

  it('AC-4: zero falls back to the default', () => {
    expect(resolveUploadMaxBytes('0')).toBe(UPLOAD_MAX_BYTES_DEFAULT);
  });

  it('AC-4: a negative value falls back to the default', () => {
    // The digits-only regex already rejects a leading `-`, so this exercises
    // the same "malformed → default" path as the non-numeric case.
    expect(resolveUploadMaxBytes('-1000')).toBe(UPLOAD_MAX_BYTES_DEFAULT);
  });

  it('AC-2: the lower bound is 1 byte', () => {
    expect(resolveUploadMaxBytes('1')).toBe(1);
  });

  it('tolerates surrounding whitespace', () => {
    expect(resolveUploadMaxBytes('  1048576  ')).toBe(1024 * 1024);
  });

  it('the default warn callback logs via console.warn, prefixed', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      resolveUploadMaxBytes(String(UPLOAD_MAX_BYTES_CEILING + 1));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toContain('[crowi:upload-limit]');
    } finally {
      spy.mockRestore();
    }
  });
});
