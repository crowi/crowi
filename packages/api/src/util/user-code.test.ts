import { generateUserCode, normalizeUserCode } from 'src/util/user-code';

/**
 * RFC-0010 Phase 4 — user_code generator + normaliser (RFC 8628 §6.1).
 */
describe('user-code', () => {
  describe('generateUserCode', () => {
    it('produces an ABCD-1234 form code', () => {
      expect(generateUserCode()).toMatch(/^[BCDFGHJKMNPQRSTVWXZ]{4}-[0-9]{4}$/);
    });

    it('never includes ambiguous glyphs (vowels, 0/O, 1/I/L) in the letters', () => {
      const letters = new Set<string>();
      for (let i = 0; i < 200; i += 1) {
        const code = generateUserCode();
        for (const ch of code.slice(0, 4)) letters.add(ch);
      }
      for (const ambiguous of ['A', 'E', 'I', 'O', 'U', 'L']) {
        expect(letters.has(ambiguous)).toBe(false);
      }
    });

    it('is reasonably random across calls', () => {
      const codes = new Set<string>();
      for (let i = 0; i < 100; i += 1) codes.add(generateUserCode());
      // 20^4 * 10^4 space — 100 draws should virtually never collide.
      expect(codes.size).toBe(100);
    });
  });

  describe('normalizeUserCode', () => {
    it('upper-cases and re-inserts the canonical dash', () => {
      expect(normalizeUserCode('bcdf1234')).toBe('BCDF-1234');
      expect(normalizeUserCode('bcdf-1234')).toBe('BCDF-1234');
      expect(normalizeUserCode('BCDF 1234')).toBe('BCDF-1234');
      expect(normalizeUserCode(' bc df-12 34 ')).toBe('BCDF-1234');
    });

    it('returns the cleaned value when length does not match', () => {
      expect(normalizeUserCode('bcd')).toBe('BCD');
    });
  });
});
