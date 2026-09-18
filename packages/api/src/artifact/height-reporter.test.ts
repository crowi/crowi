import { createHash } from 'node:crypto';

import { ARTIFACT_HEIGHT_MESSAGE_TYPE } from '@crowi/api-contract';
import type { DefaultTreeAdapterTypes } from 'parse5';

import { ARTIFACT_HEIGHT_REPORTER_DIGEST, ARTIFACT_HEIGHT_REPORTER_SCRIPT, appendArtifactHeightReporter } from './height-reporter';
import { ingestHtmlArtifact, loadParse5Runtime } from './ingest';

async function ingested(html: string): Promise<string> {
  const result = await ingestHtmlArtifact(html, { source: 'author', allowWebFonts: false, maxBytes: 2 * 1024 * 1024 });
  if (!result.ok) throw new Error(`fixture unexpectedly rejected: ${JSON.stringify(result.rejection)}`);
  return Buffer.from(result.bytes).toString('utf8');
}

function findElement(node: DefaultTreeAdapterTypes.ParentNode, tagName: string): DefaultTreeAdapterTypes.Element | null {
  for (const child of node.childNodes) {
    if ('tagName' in child) {
      if (child.tagName === tagName) return child;
      const nested = findElement(child, tagName);
      if (nested) return nested;
    }
  }
  return null;
}

describe('appendArtifactHeightReporter', () => {
  it('leaves the stored bytes intact and adds the reporter after them', async () => {
    const body = await ingested('<!doctype html><html><head><title>t</title></head><body><p>hi</p></body></html>');
    const served = appendArtifactHeightReporter(body);
    expect(served.startsWith(body)).toBe(true);
    expect(served.slice(body.length)).toBe(`<script>${ARTIFACT_HEIGHT_REPORTER_SCRIPT}</script>`);
  });

  it.each([
    ['a plain document', '<!doctype html><html><head><title>t</title></head><body><p>hi</p></body></html>'],
    ['a document whose trailing comment contains "</body>"', '<!doctype html><html><head><title>t</title></head><body><p>hi</p></body><!-- </body> --></html>'],
  ])('%s parses with the reporter as the last child of <body>, text unchanged', async (_label, html) => {
    const { parse } = loadParse5Runtime();
    const document = parse(appendArtifactHeightReporter(await ingested(html)));
    const body = findElement(document, 'body');
    const last = body?.childNodes.at(-1);
    expect(last && 'tagName' in last ? last.tagName : null).toBe('script');
    const text = last && 'childNodes' in last ? last.childNodes.map((node) => ('value' in node ? node.value : '')).join('') : null;
    expect(text).toBe(ARTIFACT_HEIGHT_REPORTER_SCRIPT);
  });
});

describe('ARTIFACT_HEIGHT_REPORTER_SCRIPT', () => {
  it('cannot end its own <script> element early or open a comment, which would change the hashed text', () => {
    expect(ARTIFACT_HEIGHT_REPORTER_SCRIPT.toLowerCase()).not.toContain('</script');
    expect(ARTIFACT_HEIGHT_REPORTER_SCRIPT).not.toContain('<!--');
  });

  it('is authorised by the exported digest', () => {
    const expected = `sha256-${createHash('sha256').update(Buffer.from(ARTIFACT_HEIGHT_REPORTER_SCRIPT, 'utf8')).digest('base64')}`;
    expect(ARTIFACT_HEIGHT_REPORTER_DIGEST).toBe(expected);
  });
});

/**
 * Runs the reporter against hand-driven layout numbers. `content` is the
 * document's own height; `frame` is the iframe height (= `innerHeight`);
 * `scrollbar` is a horizontal scrollbar's thickness, which `clientHeight`
 * loses. `vhExtra` models a `min-height: 100vh` body with that much padding
 * on top: the document is then never shorter than the frame plus `vhExtra`.
 */
function runReporter(initial: { content: number; frame: number; scrollbar?: number; vhExtra?: number }) {
  const layout = { scrollbar: 0, vhExtra: undefined as number | undefined, ...initial };
  const posted: number[] = [];
  let observerCallback: (() => void) | null = null;

  const contentHeight = () => (layout.vhExtra === undefined ? layout.content : Math.max(layout.frame, layout.content) + layout.vhExtra);
  const scroller = {
    get clientHeight() {
      return layout.frame - layout.scrollbar;
    },
    get scrollHeight() {
      return Math.max(contentHeight(), layout.frame - layout.scrollbar);
    },
  };
  const target = {
    postMessage: (message: { type: string; height: number }) => {
      expect(message.type).toBe(ARTIFACT_HEIGHT_MESSAGE_TYPE);
      posted.push(message.height);
    },
  };
  const window = {
    parent: { parent: target },
    get innerHeight() {
      return layout.frame;
    },
  };
  const document = {
    documentElement: { getBoundingClientRect: () => ({ height: contentHeight() }) },
    scrollingElement: scroller,
    body: {},
  };
  class ResizeObserver {
    constructor(callback: () => void) {
      observerCallback = callback;
    }
    observe() {}
  }

  new Function('window', 'document', 'ResizeObserver', ARTIFACT_HEIGHT_REPORTER_SCRIPT)(window, document, ResizeObserver);

  const fire = () => observerCallback?.();
  // What the page does on a report: resize the frame, which re-lays the
  // document out and fires the observer again.
  const applyLastReport = () => {
    layout.frame = posted.at(-1) ?? layout.frame;
    fire();
  };
  return { layout, posted, fire, applyLastReport };
}

describe('the reporter running inside the artifact', () => {
  it('reports the content height and stays quiet once the frame fits it', () => {
    const reporter = runReporter({ content: 3000, frame: 630 });
    reporter.fire();
    expect(reporter.posted).toEqual([3000]);
    reporter.applyLastReport();
    expect(reporter.posted).toEqual([3000]);
  });

  it('reports a shorter height when the content shrinks below the frame', () => {
    const reporter = runReporter({ content: 3000, frame: 630 });
    reporter.fire();
    reporter.applyLastReport();
    reporter.layout.content = 1200;
    reporter.fire();
    expect(reporter.posted).toEqual([3000, 1200]);
  });

  it('adds a horizontal scrollbar back so the content fits above it', () => {
    const reporter = runReporter({ content: 3000, frame: 630, scrollbar: 15 });
    reporter.fire();
    expect(reporter.posted).toEqual([3015]);
    reporter.applyLastReport();
    expect(reporter.posted).toEqual([3015]);
  });

  it('stops growing a document that is sized from the viewport instead of chasing it forever', () => {
    const reporter = runReporter({ content: 0, frame: 630, vhExtra: 48 });
    reporter.fire();
    for (let i = 0; i < 5; i++) reporter.applyLastReport();
    expect(reporter.posted).toEqual([678]);
  });

  it('still reports a real content change after withholding a viewport-driven one', () => {
    const reporter = runReporter({ content: 0, frame: 630, vhExtra: 48 });
    reporter.fire();
    reporter.applyLastReport();
    reporter.layout.content = 3000;
    reporter.fire();
    for (let i = 0; i < 5; i++) reporter.applyLastReport();
    // Grows to the content, then withholds the viewport-driven step after it.
    expect(reporter.posted).toEqual([678, 3048, 3096]);
  });
});
