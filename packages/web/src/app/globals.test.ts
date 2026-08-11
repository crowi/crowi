import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Theme-token invariants for the GitHub Alerts callouts, including the
 * WCAG 2.1 AA contrast of every title/icon colour against the surface
 * it sits on.
 *
 * The colour maths below is written out here rather than pulled from a
 * conversion library on purpose: `@crowi/web` ships no colour-space
 * dependency and one stylesheet assertion is not a reason to add one to
 * the bundle's dependency graph.
 */

const CSS = readFileSync(path.join(__dirname, 'globals.css'), 'utf8');

/** The body of the first `<selector> { … }` rule, brace-balanced (the file nests `@media` / `@theme` blocks). */
function ruleBody(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = start; i < CSS.length; i++) {
    if (CSS[i] === '{') depth += 1;
    else if (CSS[i] === '}') {
      depth -= 1;
      if (depth === 0) return CSS.slice(start, i);
    }
  }
  throw new Error(`unbalanced rule for ${selector}`);
}

const ROOT = ruleBody(':root');
const DARK = ruleBody('.dark');

const VARIANTS = ['note', 'tip', 'important', 'warning', 'caution'] as const;

/** Raw accent per variant — the border colour, and the value the title/icon must NOT use directly in light mode. */
const ACCENT_TOKEN: Record<(typeof VARIANTS)[number], string> = {
  note: '--primary',
  tip: '--crowi-success',
  important: '--crowi-important',
  warning: '--crowi-warning',
  caution: '--crowi-danger',
};

type Theme = 'light' | 'dark';

/** Custom-property declarations of one rule body, comments stripped. */
function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, name, value] of body.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(name, value.trim());
  }
  return out;
}

const TOKENS: Record<Theme, Map<string, string>> = { light: declarations(ROOT), dark: declarations(DARK) };

/** Follow a token's `var(--other)` chain the way the cascade would: a `.dark` override first, else the `:root` base. */
function resolveToken(name: string, theme: Theme): string {
  let value = TOKENS[theme].get(name) ?? TOKENS.light.get(name);
  for (let hop = 0; value?.startsWith('var(') && hop < 8; hop++) {
    const indirection = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value);
    if (!indirection) break;
    value = TOKENS[theme].get(indirection[1]) ?? TOKENS.light.get(indirection[1]);
  }
  if (!value) throw new Error(`${name} is not declared for the ${theme} theme`);
  return value;
}

/**
 * Only `oklch(L C H)` is understood — anything else (a `color-mix()`, an
 * unresolved `var()`, an sRGB hex) throws instead of being skipped, so a
 * future edit to these tokens cannot quietly opt out of the contrast
 * check below.
 */
function parseOklch(value: string): [number, number, number] {
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
  if (!match) throw new Error(`not a plain oklch() colour, so its contrast cannot be checked: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * WCAG 2.1 relative luminance of an oklch colour (Oklab → LMS → linear
 * sRGB → the 0.2126/0.7152/0.0722 sum). Components outside the sRGB
 * gamut are clamped; a browser instead reduces chroma to map them in,
 * which shifts luminance by a hair — irrelevant at the margins the
 * assertion below runs at (the one out-of-gamut value, light Warning,
 * clears 4.5:1 by more than a third).
 */
function relativeLuminance(L: number, C: number, H: number): number {
  const hue = (H * Math.PI) / 180;
  const a = C * Math.cos(hue);
  const b = C * Math.sin(hue);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const [r, g, blue] = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((component) => Math.min(1, Math.max(0, component)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const [light, dark] = [relativeLuminance(...parseOklch(foreground)), relativeLuminance(...parseOklch(background))].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * The title and the icon are the only body text drawn in a variant
 * colour. The callout paints no surface of its own, so they sit on the
 * page background. Computed from the stylesheet rather than pinned so
 * that touching either side of a pair (accent token or surface) is what
 * fails, not just touching the literal string.
 */
describe('GitHub Alerts title/icon contrast', () => {
  it.each(
    (['light', 'dark'] as const).flatMap((theme) => VARIANTS.map((variant) => [theme, variant] as const)),
  )('%s %s clears WCAG 2.1 AA 4.5:1 against the callout surface', (theme, variant) => {
    const ratio = contrastRatio(resolveToken(`--crowi-alert-${variant}-foreground`, theme), resolveToken('--background', theme));
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('rejects a token it cannot measure rather than passing it', () => {
    expect(() => contrastRatio('color-mix(in oklch, var(--primary), white)', 'oklch(0.97 0.005 192)')).toThrow(/contrast cannot be checked/);
  });
});

describe('GitHub Alerts theme tokens', () => {
  it('defines --crowi-important in both themes and bridges it into the Tailwind theme', () => {
    expect(ROOT).toContain('--crowi-important: oklch(0.5 0.16 295);');
    expect(DARK).toContain('--crowi-important: oklch(0.72 0.16 295);');
    expect(ruleBody('@theme inline')).toContain('--color-crowi-important: var(--crowi-important);');
  });

  it("gives Important its own hue instead of sharing Note's brand teal", () => {
    expect(ROOT).not.toContain(`--crowi-alert-important-foreground: var(${ACCENT_TOKEN.note})`);
    expect(DARK).not.toContain(`--crowi-alert-important-foreground: var(${ACCENT_TOKEN.note})`);
  });

  // Which colour each variant's title/icon resolves to; the ratios
  // those colours achieve are computed in the suite above.
  it.each([
    ['light', 'note', 'var(--primary)'],
    ['light', 'tip', 'oklch(0.48 0.15 145)'],
    ['light', 'important', 'var(--crowi-important)'],
    ['light', 'warning', 'oklch(0.48 0.15 70)'],
    ['light', 'caution', 'var(--crowi-danger)'],
    ['dark', 'note', 'var(--primary)'],
    ['dark', 'tip', 'var(--crowi-success)'],
    ['dark', 'important', 'var(--crowi-important)'],
    ['dark', 'warning', 'var(--crowi-warning)'],
    ['dark', 'caution', 'var(--crowi-danger)'],
  ] as const)('pins the %s %s title/icon colour', (theme, variant, value) => {
    expect(theme === 'light' ? ROOT : DARK).toContain(`--crowi-alert-${variant}-foreground: ${value};`);
  });

  it.each(VARIANTS)('maps the %s variant to its raw accent for the border and to the derived token for the title/icon', (variant) => {
    const rule = ruleBody(`.crowi-alert-${variant}`);
    expect(rule).toContain(`--crowi-alert-accent: var(${ACCENT_TOKEN[variant]});`);
    expect(rule).toContain(`--crowi-alert-foreground: var(--crowi-alert-${variant}-foreground);`);
  });

  it('colours the title and the icon from the derived token, never from a raw accent', () => {
    for (const selector of ['.crowi-alert-title', '.crowi-alert-icon']) {
      const rule = ruleBody(selector);
      expect(rule).toContain('color: var(--crowi-alert-foreground);');
      for (const accent of Object.values(ACCENT_TOKEN)) {
        expect(rule).not.toContain(`var(${accent})`);
      }
    }
  });

  it('keeps the callout unboxed — accent bar only, ordinary foreground, no fill, outline or rounding', () => {
    const rule = ruleBody('.crowi-alert');
    expect(rule).toContain('color: var(--foreground);');
    expect(rule).toContain('border-left: 3px solid var(--crowi-alert-accent);');
    // Also the guard for the contrast ratios above: those are taken
    // against `--background`, which is only the right baseline while the
    // callout paints no surface of its own.
    expect(rule).not.toContain('background');
    expect(rule).not.toContain('border-radius');
    // `border-left` is the only border; a full `border:` shorthand would
    // box the callout back up.
    expect(rule).not.toMatch(/(^|[;{]\s*)border:/);
  });
});
