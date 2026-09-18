import { ARTIFACT_HEIGHT_MESSAGE_TYPE } from '@crowi/api-contract';
import { sha256Token } from 'src/test/artifact-fixtures';

import { prepareArtifactDelivery } from './delivery';
import { ARTIFACT_HEIGHT_REPORTER_SCRIPT, appendArtifactHeightReporter } from './height-reporter';
import { ingestHtmlArtifact, loadParse5Runtime, walkArtifactTree } from './ingest';
import type { ArtifactPolicySnapshot } from './policy';

async function ingested(html: string): Promise<string> {
  const result = await ingestHtmlArtifact(html, { source: 'author', allowWebFonts: false, maxBytes: 2 * 1024 * 1024 });
  if (!result.ok) throw new Error(`fixture unexpectedly rejected: ${JSON.stringify(result.rejection)}`);
  return Buffer.from(result.bytes).toString('utf8');
}

const PLAIN_HTML = '<!doctype html><html><head><title>t</title></head><body><p>hi</p></body></html>';

const SNAPSHOT: ArtifactPolicySnapshot = Object.freeze({
  deliveryMode: 'separate-origin',
  artifactOrigin: 'https://artifacts.example.net',
  crowiOrigin: 'https://wiki.example.com',
  writeEnabled: true,
  allowWebFonts: false,
  maxBytes: 2 * 1024 * 1024,
});

const scriptSrcOf = (header: string) => header.split('; ').find((directive) => directive.startsWith('script-src'));

describe('prepareArtifactDelivery', () => {
  it('serves the stored bytes intact, followed by the reporter', async () => {
    const stored = await ingested(PLAIN_HTML);
    const result = prepareArtifactDelivery(stored, SNAPSHOT);
    if (!result.ok) throw new Error(`unexpected ${result.code}`);
    expect(result.body).toBe(`${stored}<script>${ARTIFACT_HEIGHT_REPORTER_SCRIPT}</script>`);
  });

  it('authorises the reporter alone for a document without scripts of its own', async () => {
    const result = prepareArtifactDelivery(await ingested(PLAIN_HTML), SNAPSHOT);
    if (!result.ok) throw new Error(`unexpected ${result.code}`);
    expect(scriptSrcOf(result.header)).toBe(`script-src '${sha256Token(ARTIFACT_HEIGHT_REPORTER_SCRIPT)}'`);
  });

  it("authorises the reporter ahead of the document's own scripts", async () => {
    const own = "console.log('own');";
    const result = prepareArtifactDelivery(
      await ingested(`<!doctype html><html><head><title>t</title><script>${own}</script></head><body></body></html>`),
      SNAPSHOT,
    );
    if (!result.ok) throw new Error(`unexpected ${result.code}`);
    expect(scriptSrcOf(result.header)).toBe(`script-src '${sha256Token(ARTIFACT_HEIGHT_REPORTER_SCRIPT)}' '${sha256Token(own)}'`);
  });

  it('fails with the policy error when the stored bytes carry no digest markers', () => {
    expect(prepareArtifactDelivery('<html><head></head><body></body></html>', SNAPSHOT)).toMatchObject({ ok: false, code: 'MARKER_MISSING' });
  });

  it('fails with the policy error when delivery is disabled', async () => {
    const stored = await ingested(PLAIN_HTML);
    expect(prepareArtifactDelivery(stored, { ...SNAPSHOT, deliveryMode: 'disabled' })).toMatchObject({ ok: false, code: 'DELIVERY_DISABLED' });
  });
});

describe('appendArtifactHeightReporter', () => {
  it.each([
    ['a plain document', PLAIN_HTML],
    ['a document whose trailing comment contains "</body>"', '<!doctype html><html><head><title>t</title></head><body><p>hi</p></body><!-- </body> --></html>'],
  ])('%s parses with the reporter as the last child of <body>, text unchanged', async (_label, html) => {
    const { parse } = loadParse5Runtime();
    const document = parse(appendArtifactHeightReporter(await ingested(html)));
    const body = [...walkArtifactTree(document)].find((node) => 'tagName' in node && node.tagName === 'body');
    const last = body && 'childNodes' in body ? body.childNodes.at(-1) : undefined;
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
  let mutationCallback: (() => void) | null = null;
  let mutationOptions: MutationObserverInit | null = null;
  let loadListener: (() => void) | null = null;
  const timers: (() => void)[] = [];

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
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'load') loadListener = listener;
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
  class MutationObserver {
    constructor(callback: () => void) {
      mutationCallback = callback;
    }
    observe(_target: unknown, options: MutationObserverInit) {
      mutationOptions = options;
    }
  }
  const setTimeout = (callback: () => void) => {
    timers.push(callback);
  };

  new Function('window', 'document', 'ResizeObserver', 'MutationObserver', 'setTimeout', ARTIFACT_HEIGHT_REPORTER_SCRIPT)(
    window,
    document,
    ResizeObserver,
    MutationObserver,
    setTimeout,
  );

  const fire = () => observerCallback?.();
  const mutate = () => mutationCallback?.();
  const load = () => loadListener?.();
  const runTimers = () => {
    for (const callback of timers.splice(0)) callback();
  };
  // What the page does on a report: resize the frame, which re-lays the
  // document out and fires the observer again.
  const applyLastReport = () => {
    layout.frame = posted.at(-1) ?? layout.frame;
    fire();
  };
  return { layout, posted, fire, mutate, load, runTimers, mutationOptions: () => mutationOptions, applyLastReport };
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

  it('re-measures after a DOM change that resizes neither observed box (content taken out of flow)', () => {
    const reporter = runReporter({ content: 3000, frame: 630 });
    reporter.fire();
    reporter.applyLastReport();
    // An absolutely positioned panel grows: the scroll height changes, the
    // root and body boxes do not, so no resize notification arrives.
    reporter.layout.content = 4000;
    reporter.mutate();
    reporter.mutate();
    expect(reporter.posted).toEqual([3000]);
    reporter.runTimers();
    expect(reporter.posted).toEqual([3000, 4000]);
    expect(reporter.mutationOptions()).toEqual({ attributes: true, characterData: true, childList: true, subtree: true });
  });

  it('re-measures once the document has finished loading', () => {
    const reporter = runReporter({ content: 3000, frame: 630 });
    reporter.fire();
    reporter.applyLastReport();
    reporter.layout.content = 3500;
    reporter.load();
    reporter.runTimers();
    expect(reporter.posted).toEqual([3000, 3500]);
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
