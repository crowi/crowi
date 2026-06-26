import { type CodeSegment, rewriteOutsideCode, splitCodeSegments } from './code-mask';

/**
 * Unit tests for `splitCodeSegments` — the pure Markdown code-region
 * segmenter that body-rewrite migrations use to leave `</…>` tokens inside
 * code examples untouched.
 *
 * The cardinal invariant every case must keep: concatenating the segments'
 * `text` in order reproduces the input byte-for-byte. The fences/inline split
 * is *advisory* — never lossy.
 */

const rejoin = (segments: CodeSegment[]): string => segments.map((s) => s.text).join('');
const codeText = (segments: CodeSegment[]): string[] => segments.filter((s) => s.code).map((s) => s.text);
const plainText = (segments: CodeSegment[]): string =>
  segments
    .filter((s) => !s.code)
    .map((s) => s.text)
    .join('');

describe('migration/code-mask — splitCodeSegments', () => {
  it('returns a single non-code segment for plain text (no code)', () => {
    const body = 'see </docs/api> for details';
    const segments = splitCodeSegments(body);
    expect(rejoin(segments)).toBe(body);
    expect(segments.every((s) => !s.code)).toBe(true);
  });

  it('round-trips an empty body', () => {
    expect(splitCodeSegments('')).toEqual([]);
  });

  describe('fenced code blocks (§4.5)', () => {
    it('tags a backtick fence as one code segment', () => {
      const body = 'before\n```tsx\n</AppShell>\n```\nafter';
      const segments = splitCodeSegments(body);
      expect(rejoin(segments)).toBe(body);
      expect(codeText(segments)).toEqual(['```tsx\n</AppShell>\n```\n']);
      expect(plainText(segments)).toBe('before\nafter');
    });

    it('tags a tilde fence as one code segment', () => {
      const body = 'a\n~~~\n</AppShell>\n~~~\nb';
      const segments = splitCodeSegments(body);
      expect(rejoin(segments)).toBe(body);
      expect(codeText(segments)).toEqual(['~~~\n</AppShell>\n~~~\n']);
    });

    it('treats an unclosed fence as code to EOF', () => {
      const body = 'intro\n```\n</AppShell>\nmore lines\n';
      const segments = splitCodeSegments(body);
      expect(rejoin(segments)).toBe(body);
      expect(codeText(segments)).toEqual(['```\n</AppShell>\nmore lines\n']);
      expect(plainText(segments)).toBe('intro\n');
    });

    it('requires the closing fence to be at least as long as the opener', () => {
      // A 4-backtick opener is not closed by a 3-backtick line.
      const body = '````\n</AppShell>\n```\nstill code\n````\n';
      const segments = splitCodeSegments(body);
      expect(rejoin(segments)).toBe(body);
      // The whole block is one code segment closed by the 4-backtick line.
      expect(codeText(segments)).toEqual(['````\n</AppShell>\n```\nstill code\n````\n']);
    });

    it('allows up to 3 leading spaces on the fence', () => {
      const body = '   ```\n</AppShell>\n   ```\n';
      const segments = splitCodeSegments(body);
      expect(rejoin(segments)).toBe(body);
      expect(codeText(segments).length).toBe(1);
    });

    // The closing-fence test strips the trailing `\r?\n` before matching
    // `closeRegex` (`[ \t]*$`, no `m`). Without that strip the `$` cannot reach
    // past the line's newline, so a newline-terminated close fence is never
    // recognised and the block runs to EOF — swallowing whatever follows. These
    // three cases guard that `code-mask.ts` strip as LOAD-BEARING.
    describe('closing-fence newline strip is load-bearing (:102)', () => {
      it('recognises a CRLF-terminated closing fence', () => {
        const body = 'before\r\n```\r\n</AppShell>\r\n```\r\nafter';
        const segments = splitCodeSegments(body);
        expect(rejoin(segments)).toBe(body);
        expect(codeText(segments)).toEqual(['```\r\n</AppShell>\r\n```\r\n']);
        // Critically, `after` must stay OUT of the code region.
        expect(plainText(segments)).toBe('before\r\nafter');
      });

      it('recognises an LF-terminated closing fence (not just at EOF)', () => {
        const body = '```\ncode\n```\n';
        const segments = splitCodeSegments(body);
        expect(rejoin(segments)).toBe(body);
        expect(codeText(segments)).toEqual(['```\ncode\n```\n']);
      });

      it('does NOT swallow content that follows a newline-terminated closing fence', () => {
        // The decisive case: the close fence `` ``` `` is mid-body (terminated by
        // `\n`, not EOF). If the strip were removed the `$` would miss it and
        // `more text` would be wrongly absorbed into the code segment.
        const body = '```\ncode\n```\nmore text';
        const segments = splitCodeSegments(body);
        expect(rejoin(segments)).toBe(body);
        expect(codeText(segments)).toEqual(['```\ncode\n```\n']);
        expect(plainText(segments)).toBe('more text');
      });
    });
  });

  describe('inline code spans (§6.1)', () => {
    it('tags a single-backtick span as code', () => {
      const body = 'see `</AppShell>` here';
      const segments = splitCodeSegments(body);
      expect(rejoin(segments)).toBe(body);
      expect(codeText(segments)).toEqual(['`</AppShell>`']);
      expect(plainText(segments)).toBe('see  here');
    });

    it('matches an N-backtick opener with exactly N closing backticks', () => {
      const body = 'x ``a`b`` y';
      const segments = splitCodeSegments(body);
      expect(rejoin(segments)).toBe(body);
      // The inner single backtick does NOT close a double-backtick span.
      expect(codeText(segments)).toEqual(['``a`b``']);
    });

    it('leaves an unmatched single backtick as literal non-code text', () => {
      // A lone backtick with no closer: the `</AppShell>` after it is NOT code.
      const body = 'a ` </AppShell> b';
      const segments = splitCodeSegments(body);
      expect(rejoin(segments)).toBe(body);
      expect(codeText(segments)).toEqual([]);
      expect(segments.every((s) => !s.code)).toBe(true);
    });
  });

  describe('indented code is NOT treated as code (renderer divergence)', () => {
    it('keeps a 4-space-indented line as rewritable text', () => {
      const body = 'para\n\n    </AppShell>\n';
      const segments = splitCodeSegments(body);
      expect(rejoin(segments)).toBe(body);
      expect(codeText(segments)).toEqual([]);
    });

    it('keeps a 4-space paragraph-continuation line as rewritable text', () => {
      const body = 'lead\n    </AppShell>\n';
      const segments = splitCodeSegments(body);
      expect(rejoin(segments)).toBe(body);
      expect(codeText(segments)).toEqual([]);
    });
  });

  describe('adjacency / order / by-reference', () => {
    it('keeps two adjacent inline spans (single-space separated) as two distinct code segments (no merge)', () => {
      const body = '`</A>` `</B>`';
      const segments = splitCodeSegments(body);
      expect(rejoin(segments)).toBe(body);
      expect(codeText(segments)).toEqual(['`</A>`', '`</B>`']);
    });

    it('treats `…`…`…` as one span per CommonMark (inner run is literal content, both tokens still protected)', () => {
      // `</A>``</B>` is NOT two spans: the 1-backtick opener is closed by the
      // final single backtick, so the inner `` is literal content. Both tokens
      // stay inside code and round-trip byte-identically — nothing is dropped.
      const body = '`</A>``</B>`';
      const segments = splitCodeSegments(body);
      expect(rejoin(segments)).toBe(body);
      expect(codeText(segments)).toEqual(['`</A>``</B>`']);
    });

    it('keeps a fence immediately followed by an inline span as two code regions', () => {
      const body = '```tsx\n</A>\n```\n`</B>`';
      const segments = splitCodeSegments(body);
      expect(rejoin(segments)).toBe(body);
      expect(codeText(segments)).toEqual(['```tsx\n</A>\n```\n', '`</B>`']);
    });

    it('preserves order when an inline span precedes a fence (no swap)', () => {
      const body = '`</A>` text\n```tsx\n</B>\n```\n';
      const segments = splitCodeSegments(body);
      expect(rejoin(segments)).toBe(body);
      const codes = codeText(segments);
      // `</A>` must come before the fence body in the segment list.
      expect(codes[0]).toBe('`</A>`');
      expect(codes[1]).toBe('```tsx\n</B>\n```\n');
    });

    it('round-trips a NUL byte in the body without sentinel collision', () => {
      const body = 'a\x00b `</A>` c';
      const segments = splitCodeSegments(body);
      expect(rejoin(segments)).toBe(body);
      expect(codeText(segments)).toEqual(['`</A>`']);
    });
  });
});

/**
 * Unit tests for `rewriteOutsideCode` — the shared body-rewrite primitive that
 * runs a caller's `fn` over only the non-code segments and re-joins in order,
 * preserving the `result === body` cheap-skip when nothing changed.
 */
describe('migration/code-mask — rewriteOutsideCode', () => {
  it('returns the input BY REFERENCE for an identity fn (no-op)', () => {
    const body = 'see </docs/api> and `</code>` here';
    const result = rewriteOutsideCode(body, (x) => x);
    expect(result).toBe(body); // same reference, not just equal
  });

  it('returns the input BY REFERENCE when fn leaves every non-code segment unchanged', () => {
    // fn is non-trivial but matches nothing in this body.
    const body = 'plain text with no FOO token; `code FOO span`';
    const result = rewriteOutsideCode(body, (text) => text.replace(/BAR/g, 'BAZ'));
    expect(result).toBe(body);
  });

  it('applies fn only to non-code segments and keeps code byte-identical', () => {
    const body = 'X here\n```\nX in fence\n```\nand `X inline` then X again';
    const result = rewriteOutsideCode(body, (text) => text.replace(/X/g, 'Y'));
    // The fenced `X` and the inline-span `X` are preserved; the two plain `X`
    // tokens become `Y`.
    expect(result).toBe('Y here\n```\nX in fence\n```\nand `X inline` then Y again');
    // The code regions survive verbatim.
    expect(result).toContain('```\nX in fence\n```');
    expect(result).toContain('`X inline`');
  });

  it('rejoins adjacent code/non-code regions in original order (no merge / no swap)', () => {
    // An inline span, then a fence, then a trailing plain segment — fn uppercases
    // only the plain segments, and the two code regions must stay in place.
    const body = '`</A>` mid\n```\n</B>\n```\ntail';
    const result = rewriteOutsideCode(body, (text) => text.toUpperCase());
    expect(result).toBe('`</A>` MID\n```\n</B>\n```\nTAIL');
    // Order preserved: the inline span precedes the fence which precedes `TAIL`.
    expect(result.indexOf('`</A>`')).toBeLessThan(result.indexOf('```'));
    expect(result.indexOf('```')).toBeLessThan(result.indexOf('TAIL'));
  });

  it('invokes fn once per non-code segment, never on code segments', () => {
    const body = 'plain1 `code` plain2';
    const seen: string[] = [];
    rewriteOutsideCode(body, (text) => {
      seen.push(text);
      return text;
    });
    // Two plain segments, the code span is never passed to fn.
    expect(seen).toEqual(['plain1 ', ' plain2']);
  });
});
