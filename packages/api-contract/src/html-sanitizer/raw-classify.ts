import { isKnownTag } from '../util/known-tags';
import type { HtmlSanitizationPolicy, LNode } from './model';
import { CODE_CONTENT_TAGS } from './model';

/**
 * Pre-parse lexical classification of author raw HTML (spec R-3).
 *
 * The HTML parser alone cannot be trusted to keep following Markdown
 * structure: an unclosed `<select>`/`<title>`/`<col>` or an unfinished tag at
 * the end of a chunk swallows or reorders whatever comes next. So the chunks
 * are scanned here, with an explicit, parser-independent definition of
 * "closed", and the offending tokens are turned into literal text (or cut out
 * when a code-content element is closed inside one chunk) before parsing.
 */

// Leading tag-name of a raw-HTML chunk: `<thing …>` / `</thing>` / `<thing/>`.
// Allows `:` so namespaced paste junk (`<o:p>`) is caught. `<!-- … -->` and
// `<!doctype>` start with `<!`, never match, and pass through unchanged.
const RAW_LEADING_TAG_RE = /^\s*<\/?\s*([a-zA-Z][a-zA-Z0-9:_-]*)/;

/**
 * Turns raw chunks whose leading tag no browser recognises into text so they
 * show as the literal characters the author typed (`No <thing> yet`) instead
 * of becoming empty unknown DOM elements. Mutates `tree` (callers pass their
 * own clone).
 */
export function escapeUnknownRawHtml(tree: { children?: LNode[] }): void {
  const stack: Array<{ children?: LNode[] }> = [tree];
  while (stack.length > 0) {
    const current = stack.pop() as { children?: LNode[] };
    if (!current.children) continue;
    for (const child of current.children) {
      if (child.children) stack.push(child);
      if (child.content?.children) stack.push(child.content);
      if (child.type === 'raw' && typeof child.value === 'string') {
        const tag = RAW_LEADING_TAG_RE.exec(child.value)?.[1];
        if (tag && !isKnownTag(tag)) child.type = 'text';
      }
    }
  }
}

interface RawToken {
  kind: 'start' | 'end' | 'comment' | 'decl';
  s: number;
  e: number;
  name: string;
  complete: boolean;
  demoted: boolean;
}

interface Edit {
  s: number;
  e: number;
  action: 'cut' | 'text';
}

interface Chunk {
  node: LNode;
  parent: LNode;
  /** Offsets of this chunk inside its run's concatenated text. */
  s: number;
  e: number;
}

interface Run {
  chunks: Chunk[];
  text: string;
  tokens: RawToken[];
  edits: Edit[];
}

const WS = /[\t\n\f\r ]/;
const TAG_NAME_END = /[\t\n\f\r />]/;
const ATTR_NAME_END = /[\t\n\f\r />=]/;

interface TagScan {
  e: number;
  complete: boolean;
  name: string;
}

/** Scans one start/end tag whose `<` is at `i`; `limit` is the end of the text it may use. */
function scanTag(text: string, i: number, isEnd: boolean, limit: number): TagScan {
  let p = i + (isEnd ? 2 : 1);
  const nameStart = p;
  while (p < limit && !TAG_NAME_END.test(text[p] as string)) p += 1;
  const name = text.slice(nameStart, p).toLowerCase();
  for (;;) {
    while (p < limit && (WS.test(text[p] as string) || text[p] === '/')) p += 1;
    if (p >= limit) return { e: limit, complete: false, name };
    if (text[p] === '>') return { e: p + 1, complete: true, name };
    p += 1;
    while (p < limit && !ATTR_NAME_END.test(text[p] as string)) p += 1;
    while (p < limit && WS.test(text[p] as string)) p += 1;
    if (p < limit && text[p] === '=') {
      p += 1;
      while (p < limit && WS.test(text[p] as string)) p += 1;
      if (p >= limit) return { e: limit, complete: false, name };
      const quote = text[p];
      if (quote === '"' || quote === "'") {
        const close = text.indexOf(quote, p + 1);
        if (close < 0 || close >= limit) return { e: limit, complete: false, name };
        p = close + 1;
      } else {
        while (p < limit && !WS.test(text[p] as string) && text[p] !== '>') p += 1;
      }
    }
  }
}

const COMMENT_CLOSE_RE = /--!?>/g;

function isAsciiAlpha(ch: string | undefined): boolean {
  return ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'));
}

/** Memoised closing-tag candidates for one (chunk, tag name): found once, searched by position. */
class CloserIndex {
  private readonly cache = new Map<string, Array<{ idx: number; e: number; complete: boolean }>>();
  private readonly cursor = new Map<string, number>();

  constructor(private readonly text: string) {}

  /** Candidates in source order, with `from` only ever growing within one run's scan. */
  private candidatesFrom(name: string, from: number, limit: number): { candidates: Array<{ idx: number; e: number; complete: boolean }>; start: number } {
    const key = `${name}:${limit}`;
    let candidates = this.cache.get(key);
    if (!candidates) {
      candidates = [];
      const re = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, 'gi');
      const slice = this.text.slice(0, limit);
      let m: RegExpExecArray | null = re.exec(slice);
      while (m) {
        const scan = scanTag(slice, m.index, true, limit);
        candidates.push({ idx: m.index, e: scan.e, complete: scan.complete });
        m = re.exec(slice);
      }
      this.cache.set(key, candidates);
    }
    let start = this.cursor.get(key) ?? 0;
    while (start < candidates.length && (candidates[start] as { idx: number }).idx < from) start += 1;
    this.cursor.set(key, start);
    return { candidates, start };
  }

  /** First complete `</name …>` at or after `from` that ends inside [from, limit]. */
  find(name: string, from: number, limit: number): number | undefined {
    const { candidates, start } = this.candidatesFrom(name, from, limit);
    for (let k = start; k < candidates.length; k += 1) {
      const c = candidates[k] as { e: number; complete: boolean };
      if (c.complete) return c.e;
    }
    return undefined;
  }

  /**
   * The relaxed iframe rule: only the FIRST `</name` terminator candidate at or
   * after `from` counts, and only when it is a complete end tag ending inside
   * [from, limit]. A later complete closer never repairs an incomplete first one.
   */
  firstComplete(name: string, from: number, limit: number): number | undefined {
    const { candidates, start } = this.candidatesFrom(name, from, limit);
    const first = candidates[start];
    return first?.complete ? first.e : undefined;
  }
}

function scanRun(run: Run, policy: HtmlSanitizationPolicy): void {
  const { text } = run;
  const n = text.length;
  const closers = new CloserIndex(text);
  const chunkAt = (i: number): Chunk => {
    // Runs hold few chunks; linear lookup keeps this simple.
    for (const chunk of run.chunks) if (i >= chunk.s && i < chunk.e) return chunk;
    return run.chunks[run.chunks.length - 1] as Chunk;
  };
  let i = 0;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    i = lt;
    const next = text[i + 1];

    if (text.startsWith('<!--', i)) {
      let e = -1;
      if (text.startsWith('<!-->', i)) e = i + 5;
      else if (text.startsWith('<!--->', i)) e = i + 6;
      else {
        COMMENT_CLOSE_RE.lastIndex = i + 4;
        const m = COMMENT_CLOSE_RE.exec(text);
        if (m) e = m.index + m[0].length;
      }
      const complete = e >= 0;
      run.tokens.push({ kind: 'comment', s: i, e: complete ? e : n, name: '', complete, demoted: false });
      i = complete ? e : n;
      continue;
    }
    if (next === '!' || next === '?' || (next === '/' && !isAsciiAlpha(text[i + 2]))) {
      const close = text.indexOf('>', i + 2);
      const complete = close >= 0;
      run.tokens.push({ kind: 'decl', s: i, e: complete ? close + 1 : n, name: '', complete, demoted: false });
      i = complete ? close + 1 : n;
      continue;
    }
    const isEnd = next === '/';
    if (!(isAsciiAlpha(next) || (isEnd && isAsciiAlpha(text[i + 2])))) {
      i += 1;
      continue;
    }
    const scan = scanTag(text, i, isEnd, n);
    const token: RawToken = { kind: isEnd ? 'end' : 'start', s: i, e: scan.e, name: scan.name, complete: scan.complete, demoted: false };
    run.tokens.push(token);
    i = scan.e;
    if (isEnd || !scan.complete || !CODE_CONTENT_TAGS.has(scan.name)) continue;

    const chunk = chunkAt(token.s);
    if (token.e > chunk.e) {
      token.demoted = true;
      run.edits.push({ s: token.s, e: token.e, action: 'text' });
      continue;
    }
    if (policy === 'relaxed' && scan.name === 'iframe') {
      const iframeEnd = closers.firstComplete('iframe', token.e, chunk.e);
      if (iframeEnd === undefined) {
        token.demoted = true;
        run.edits.push({ s: token.s, e: token.e, action: 'text' });
      } else {
        // The whole shell stays raw for the parser; its raw-text body is not scanned.
        i = iframeEnd;
      }
      continue;
    }
    const closeEnd = closers.find(scan.name, token.e, chunk.e);
    if (closeEnd === undefined) {
      token.demoted = true;
      run.edits.push({ s: token.s, e: token.e, action: 'text' });
    } else {
      // The whole closed element — start, content, end — disappears.
      run.tokens.pop();
      run.edits.push({ s: token.s, e: closeEnd, action: 'cut' });
      i = closeEnd;
    }
  }
}

type Event = { kind: 'raw'; node: LNode; parent: LNode } | { kind: 'boundary'; element: boolean };

function collectEvents(root: LNode): Event[] {
  const events: Event[] = [];
  const visit = (parent: LNode): void => {
    for (const child of parent.children ?? []) {
      if (child.type === 'raw' && typeof child.value === 'string') {
        events.push({ kind: 'raw', node: child, parent });
      } else if (child.type === 'element') {
        events.push({ kind: 'boundary', element: true });
        visit(child);
        events.push({ kind: 'boundary', element: false });
      } else {
        events.push({ kind: 'boundary', element: false });
      }
    }
  };
  visit(root);
  return events;
}

function segmentChunk(chunk: Chunk, run: Run, edits: Edit[]): LNode[] {
  const out: LNode[] = [];
  const value = chunk.node.value as string;
  let pos = chunk.s;
  const pushRaw = (s: number, e: number): void => {
    if (e > s) out.push({ type: 'raw', value: run.text.slice(s, e) });
  };
  const pushText = (s: number, e: number): void => {
    if (e > s) out.push({ type: 'text', value: run.text.slice(s, e) });
  };
  for (const edit of edits) {
    const s = Math.max(edit.s, chunk.s);
    const e = Math.min(edit.e, chunk.e);
    if (e <= s) continue;
    if (edit.action === 'text') {
      pushRaw(pos, s);
      pushText(s, e);
    } else if (run.text[s - 1] === '<' && s - 1 >= pos) {
      // A lone `<` left at the cut would fuse with whatever follows the cut
      // into a new tag, so it is shown as text instead.
      pushRaw(pos, s - 1);
      pushText(s - 1, s);
    } else {
      pushRaw(pos, s);
    }
    pos = e;
  }
  pushRaw(pos, chunk.e);
  if (out.length === 1 && out[0]?.type === 'raw' && out[0].value === value) return [chunk.node];
  return out;
}

/**
 * Classifies author raw chunks (after unknown-leading chunks are already
 * text) and rewrites them in place: closed code-content regions are cut,
 * unclosed code-content/select tokens, a leading `<col>` and a trailing
 * unfinished tag/attribute/comment become literal text.
 */
export function classifyAuthoredRaw(root: LNode, policy: HtmlSanitizationPolicy = 'strict'): void {
  const events = collectEvents(root);

  // Group consecutive raw events into runs: the tokenizer carries state
  // between raw chunks that have no node between them.
  const runs: Run[] = [];
  const runOfEvent: number[] = [];
  let current: Run | undefined;
  for (let k = 0; k < events.length; k += 1) {
    const event = events[k] as Event;
    if (event.kind === 'boundary') {
      current = undefined;
      runOfEvent.push(-1);
      continue;
    }
    if (!current) {
      current = { chunks: [], text: '', tokens: [], edits: [] };
      runs.push(current);
    }
    const s = current.text.length;
    current.text += event.node.value as string;
    current.chunks.push({ node: event.node, parent: event.parent, s, e: current.text.length });
    runOfEvent.push(runs.length - 1);
  }
  if (runs.length === 0) return;

  for (const run of runs) scanRun(run, policy);

  // `select` is closed only by a later explicit end tag anywhere in the
  // author raw that follows it.
  let lastSelectEnd: { run: number; at: number } | undefined;
  runs.forEach((run, runIndex) => {
    for (const token of run.tokens) if (token.kind === 'end' && token.complete && token.name === 'select') lastSelectEnd = { run: runIndex, at: token.s };
  });

  let sawElementStart = false;
  let runCursor = -1;
  for (let k = 0; k < events.length; k += 1) {
    const event = events[k] as Event;
    if (event.kind === 'boundary') {
      if (event.element) sawElementStart = true;
      continue;
    }
    const runIndex = runOfEvent[k] as number;
    if (runIndex === runCursor) continue;
    runCursor = runIndex;
    const run = runs[runIndex] as Run;
    for (const token of run.tokens) {
      if (token.kind !== 'start' || !token.complete || token.demoted) continue;
      if (token.name === 'select') {
        const closed = lastSelectEnd !== undefined && (lastSelectEnd.run > runIndex || (lastSelectEnd.run === runIndex && lastSelectEnd.at > token.s));
        if (!closed) {
          token.demoted = true;
          run.edits.push({ s: token.s, e: token.e, action: 'text' });
          continue;
        }
      }
      if (token.name === 'col' && !sawElementStart) {
        token.demoted = true;
        run.edits.push({ s: token.s, e: token.e, action: 'text' });
        continue;
      }
      sawElementStart = true;
    }
    const last = run.tokens[run.tokens.length - 1];
    if (last && !last.complete && last.kind !== 'decl') run.edits.push({ s: last.s, e: run.text.length, action: 'text' });
  }

  const replacements = new Map<LNode, LNode[]>();
  for (const run of runs) {
    run.edits.sort((a, b) => a.s - b.s);
    // Drop edits swallowed by an earlier, larger one (a demoted token inside a tail).
    const edits: Edit[] = [];
    for (const edit of run.edits) {
      const prev = edits[edits.length - 1];
      if (prev && edit.s < prev.e) continue;
      edits.push(edit);
    }
    for (const chunk of run.chunks) {
      const segments = segmentChunk(chunk, run, edits);
      if (segments.length !== 1 || segments[0] !== chunk.node) replacements.set(chunk.node, segments);
    }
  }
  if (replacements.size === 0) return;

  const rewrite = (parent: LNode): void => {
    if (!parent.children) return;
    let changed = false;
    const next: LNode[] = [];
    for (const child of parent.children) {
      const replacement = replacements.get(child);
      if (replacement) {
        next.push(...replacement);
        changed = true;
      } else {
        if (child.children) rewrite(child);
        next.push(child);
      }
    }
    if (changed) parent.children = next;
  };
  rewrite(root);
}
