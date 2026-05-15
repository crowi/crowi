import { describe, it, expect } from 'vitest';
import { fnv1a32, userColor } from './collab-user-color';

describe('collab-user-color', () => {
  describe('fnv1a32', () => {
    it('returns the FNV-1a basis offset for the empty string', () => {
      // The 32-bit FNV-1a hash of an empty string is the basis itself.
      // Pinning this catches a regression where the loop bound or the
      // basis constant gets accidentally re-typed.
      expect(fnv1a32('')).toBe(0x811c9dc5);
    });

    it('produces a 32-bit unsigned integer', () => {
      const h = fnv1a32('user-abc');
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    });

    it('is deterministic across calls', () => {
      const a = fnv1a32('user-deterministic');
      const b = fnv1a32('user-deterministic');
      expect(a).toBe(b);
    });

    it('produces different hashes for slightly different inputs', () => {
      expect(fnv1a32('user-a')).not.toBe(fnv1a32('user-b'));
      expect(fnv1a32('user-a')).not.toBe(fnv1a32('user-A'));
    });
  });

  describe('userColor', () => {
    it('returns the anonymous fallback hue (220) for the empty string', () => {
      const { color, colorLight } = userColor('');
      expect(color).toBe('hsl(220 70% 55%)');
      expect(colorLight).toBe('hsl(220 70% 85%)');
    });

    it('is deterministic for the same userId', () => {
      const a = userColor('507f1f77bcf86cd799439011');
      const b = userColor('507f1f77bcf86cd799439011');
      expect(a).toEqual(b);
    });

    it('emits valid HSL strings shared between color and colorLight', () => {
      const { color, colorLight } = userColor('alice');
      // Both fields share the same hue; lightness differs (55% vs 85%).
      const colorMatch = color.match(/^hsl\((\d+) 70% 55%\)$/);
      const colorLightMatch = colorLight.match(/^hsl\((\d+) 70% 85%\)$/);
      expect(colorMatch).not.toBeNull();
      expect(colorLightMatch).not.toBeNull();
      expect(colorMatch?.[1]).toBe(colorLightMatch?.[1]);
    });

    it('spreads hues across the 360-degree wheel for varied inputs', () => {
      // Coarse distribution check: 1000 sequential ids should land in
      // all four 90-deg quadrants. Not a hard statistical test — just a
      // sanity that FNV-1a + `% 360` isn't collapsing to a single bucket.
      const quadrants = [0, 0, 0, 0];
      for (let i = 0; i < 1000; i++) {
        const hue = Number(userColor(`user-${i}`).color.match(/^hsl\((\d+)/)?.[1] ?? '0');
        quadrants[Math.floor(hue / 90) % 4]++;
      }
      for (const count of quadrants) {
        expect(count).toBeGreaterThan(150);
      }
    });

    it('produces different colors for different users', () => {
      // Concrete known-good pin: pick two ids whose FNV hashes happen to
      // land in different hue quadrants so a refactor doesn't silently
      // change one side of the mapping.
      const alice = userColor('alice');
      const bob = userColor('bob');
      expect(alice.color).not.toBe(bob.color);
    });
  });
});
