/**
 * Markdown code-region segmentation for the body-rewrite migrations.
 *
 * `WIKILINK_DETECTION_REGEX` (and the sibling `files-url` / `html-recover`
 * probes) scan a page's *raw* body with no Markdown awareness, so `</…>`
 * tokens written as code examples — inside a ```` ``` ```` fence or `` `…` ``
 * inline span — get misdetected as v1 wikilinks and rewritten, corrupting the
 * code (e.g. ```` ```tsx\n</AppShell>\n``` ```` → `[[/AppShell]]`).
 *
 * The renderer already solves this at the AST level — `renderer/core/
 * wikilinks.ts` skips `node.type === 'code' || 'inlineCode'`. The migration
 * layer cannot import the renderer pipeline (jiti/ESM), so this is a
 * string-level parallel of that intent: split the body into ordered
 * `code` / non-`code` segments so callers can run their rewrite **only on
 * the non-`code` segments** and re-join in original order.
 *
 * Why segmentation and NOT a same-length `\x00` fill + slice restore: a fill
 * pass keeps the body length-invariant, but the rewrite step changes the
 * length of the *non-code* text, so a positional restore drifts. Worse, three
 * structural failures cause silent data loss — adjacent code regions whose
 * fills touch merge into one `/\x00+/g` match (one region is dropped), a
 * fence-first stash with text-order restore swaps two regions, and a `\x00`
 * already present in pasted/binary content collides with the sentinel. By
 * returning an ordered segment list with no restore step, all three are
 * avoided *by construction*: adjacent regions are distinct segments (no
 * merge), order is preserved by the list (no swap), and no sentinel is ever
 * introduced (no collision).
 *
 * Coverage: fenced code blocks (CommonMark §4.5, backtick **and** tilde) and
 * inline code spans (§6.1). Indented code blocks (4-space / 1-tab, §4.4) are
 * deliberately NOT covered: a flat "4-space line = code" rule over-suppresses
 * (mdast treats a 4-space paragraph/list continuation line as text/html, i.e.
 * rewritable), so an indented-code `</…>` token stays rewritable — an accepted
 * known divergence from the renderer (see the spec's "out of scope").
 */

/** One ordered slice of the body, tagged with whether it is a code region. */
export interface CodeSegment {
  /** True for fenced-code-block / inline-code-span regions (rewrite-exempt). */
  code: boolean;
  /** The verbatim substring; concatenating every segment's `text` in order rebuilds the body. */
  text: string;
}

/** A fenced-code-block opener: ≥3 backticks or ≥3 tildes with 0–3 leading spaces. */
const FENCE_OPEN_REGEX = /^( {0,3})(`{3,}|~{3,})/;

/**
 * Split `body` into ordered `code` / non-`code` segments.
 *
 * Fenced blocks are matched line-by-line (a fence runs to its closing fence of
 * the same char, ≥ the opening length; an unclosed fence runs to EOF). Within
 * non-fence text, inline code spans are matched by the CommonMark §6.1 rule: an
 * opening run of N backticks closed by the next run of *exactly* N backticks.
 * An unmatched backtick run is left as literal non-code text.
 *
 * Pure: no I/O, no mutation of inputs. Concatenating the returned segments'
 * `text` reproduces `body` byte-for-byte.
 */
export function splitCodeSegments(body: string): CodeSegment[] {
  const segments: CodeSegment[] = [];
  // Buffer of pending non-code text; flushed (after inline-span extraction)
  // whenever a fence boundary or EOF is reached.
  let pendingText = '';

  const flushPendingText = (): void => {
    if (pendingText.length === 0) return;
    for (const seg of splitInlineCode(pendingText)) segments.push(seg);
    pendingText = '';
  };

  // Walk the body line by line, preserving each line's trailing newline so the
  // re-join is byte-identical. `lineStart` indexes the current line's first
  // char in `body`.
  let lineStart = 0;
  while (lineStart < body.length) {
    let lineEnd = body.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = body.length;
    else lineEnd += 1; // include the newline
    const line = body.slice(lineStart, lineEnd);

    const fenceMatch = FENCE_OPEN_REGEX.exec(line.replace(/\r?\n$/, ''));
    if (fenceMatch) {
      // A fenced code block opens here. Flush text accumulated before it, then
      // consume lines up to (and including) the matching closing fence or EOF.
      flushPendingText();
      const fenceChar = fenceMatch[2][0];
      const fenceLen = fenceMatch[2].length;
      const closeRegex = new RegExp(`^ {0,3}${fenceChar === '`' ? '`' : '~'}{${fenceLen},}[ \\t]*$`);

      // Consume lines up to (and including) the closing fence; an unclosed
      // fence runs to EOF. Either way the whole span is one code segment.
      let fenceText = line;
      let cursor = lineEnd;
      while (cursor < body.length) {
        let nextEnd = body.indexOf('\n', cursor);
        if (nextEnd === -1) nextEnd = body.length;
        else nextEnd += 1;
        const nextLine = body.slice(cursor, nextEnd);
        fenceText += nextLine;
        cursor = nextEnd;
        if (closeRegex.test(nextLine.replace(/\r?\n$/, ''))) break;
      }
      segments.push({ code: true, text: fenceText });
      lineStart = cursor;
      continue;
    }

    pendingText += line;
    lineStart = lineEnd;
  }

  flushPendingText();

  // The common "no code at all" body yields exactly one `{ code: false }`
  // segment (the whole body, via `splitInlineCode`'s trailing `pushPlain`), so
  // the caller's by-reference cheap-skip still works on the re-join.
  return segments;
}

/**
 * Split a run of non-fence text into inline-code (`code: true`) and plain
 * (`code: false`) segments per CommonMark §6.1: an opening run of N backticks
 * closed by the next run of *exactly* N backticks is a code span. An unmatched
 * backtick run stays literal (folded into the surrounding plain segment).
 */
function splitInlineCode(text: string): CodeSegment[] {
  const segments: CodeSegment[] = [];
  let plainStart = 0;
  let i = 0;

  const pushPlain = (end: number): void => {
    if (end > plainStart) segments.push({ code: false, text: text.slice(plainStart, end) });
  };

  while (i < text.length) {
    if (text[i] !== '`') {
      i += 1;
      continue;
    }
    // Measure the opening backtick run length.
    const openStart = i;
    let runLen = 0;
    while (i < text.length && text[i] === '`') {
      runLen += 1;
      i += 1;
    }
    // Look for a closing run of exactly `runLen` backticks.
    let scan = i;
    let closeStart = -1;
    while (scan < text.length) {
      if (text[scan] !== '`') {
        scan += 1;
        continue;
      }
      let closeLen = 0;
      const thisRunStart = scan;
      while (scan < text.length && text[scan] === '`') {
        closeLen += 1;
        scan += 1;
      }
      if (closeLen === runLen) {
        closeStart = thisRunStart;
        break;
      }
      // A run of a different length is not a valid closer; keep scanning.
    }

    if (closeStart === -1) {
      // Unmatched opener — leave the backtick run as literal text and continue
      // scanning from just after it (so a later valid span is still found).
      continue;
    }

    // Emit the plain text before the span, then the span itself.
    pushPlain(openStart);
    const spanEnd = closeStart + runLen;
    segments.push({ code: true, text: text.slice(openStart, spanEnd) });
    plainStart = spanEnd;
    i = spanEnd;
  }

  pushPlain(text.length);
  return segments;
}
