import { ARTIFACT_ESCAPE_MESSAGE_TYPE, ARTIFACT_HEIGHT_MESSAGE_TYPE, ARTIFACT_LINK_MAX_LENGTH, ARTIFACT_NAVIGATE_MESSAGE_TYPE } from '@crowi/api-contract';
import { sha256Token } from 'src/test/artifact-fixtures';

import { DEFAULT_ARTIFACT_MAX_BYTES } from './constants';
import { prepareArtifactDelivery } from './delivery';
import {
  ARTIFACT_FRAME_BRIDGE_DIGEST,
  ARTIFACT_FRAME_BRIDGE_SCRIPT,
  ARTIFACT_NAVIGATION_GUARD_DIGEST,
  ARTIFACT_NAVIGATION_GUARD_SCRIPT,
  appendArtifactFrameBridge,
  insertArtifactNavigationGuard,
} from './frame-bridge';
import { ingestHtmlArtifact, loadParse5Runtime, walkArtifactTree } from './ingest';
import type { ArtifactPolicySnapshot } from './policy';

async function ingested(html: string): Promise<string> {
  const result = await ingestHtmlArtifact(html, { source: 'author', allowWebFonts: false, maxBytes: DEFAULT_ARTIFACT_MAX_BYTES });
  if (!result.ok) throw new Error(`fixture unexpectedly rejected: ${JSON.stringify(result.rejection)}`);
  return Buffer.from(result.bytes).toString('utf8');
}

// Mirrors the page's cap on the frame height (`artifact-view.tsx`), which lives in the web package.
const MAX_ARTIFACT_FRAME_HEIGHT = 100_000;

const PLAIN_HTML = '<!doctype html><html><head><title>t</title></head><body><p>hi</p></body></html>';

const SNAPSHOT: ArtifactPolicySnapshot = Object.freeze({
  deliveryMode: 'separate-origin',
  artifactOrigin: 'https://artifacts.example.net',
  crowiOrigin: 'https://wiki.example.com',
  writeEnabled: true,
  allowWebFonts: false,
  maxBytes: DEFAULT_ARTIFACT_MAX_BYTES,
});

const scriptSrcOf = (header: string) => header.split('; ').find((directive) => directive.startsWith('script-src'));

const guardTag = `<script>${ARTIFACT_NAVIGATION_GUARD_SCRIPT}</script>`;
const bridgeTag = `<script>${ARTIFACT_FRAME_BRIDGE_SCRIPT}</script>`;
const OWN_AUTHORISED = `'${sha256Token(ARTIFACT_NAVIGATION_GUARD_SCRIPT)}' '${sha256Token(ARTIFACT_FRAME_BRIDGE_SCRIPT)}'`;

describe('prepareArtifactDelivery', () => {
  it('serves the stored bytes intact, with the guard right before </head> and the frame bridge at the end', async () => {
    const stored = await ingested(PLAIN_HTML);
    const result = prepareArtifactDelivery(stored, SNAPSHOT);
    if (!result.ok) throw new Error(`unexpected ${result.code}`);
    const headClose = stored.indexOf('</head>');
    expect(result.body).toBe(`${stored.slice(0, headClose)}${guardTag}${stored.slice(headClose)}${bridgeTag}`);
  });

  it('authorises the guard and the frame bridge for a document without scripts of its own', async () => {
    const result = prepareArtifactDelivery(await ingested(PLAIN_HTML), SNAPSHOT);
    if (!result.ok) throw new Error(`unexpected ${result.code}`);
    expect(scriptSrcOf(result.header)).toBe(`script-src ${OWN_AUTHORISED}`);
    expect(ARTIFACT_NAVIGATION_GUARD_DIGEST).toBe(sha256Token(ARTIFACT_NAVIGATION_GUARD_SCRIPT));
    expect(ARTIFACT_FRAME_BRIDGE_DIGEST).toBe(sha256Token(ARTIFACT_FRAME_BRIDGE_SCRIPT));
  });

  it("authorises the guard and the frame bridge ahead of the document's own scripts", async () => {
    const own = "console.log('own');";
    const result = prepareArtifactDelivery(
      await ingested(`<!doctype html><html><head><title>t</title><script>${own}</script></head><body></body></html>`),
      SNAPSHOT,
    );
    if (!result.ok) throw new Error(`unexpected ${result.code}`);
    expect(scriptSrcOf(result.header)).toBe(`script-src ${OWN_AUTHORISED} '${sha256Token(own)}'`);
  });

  it('fails with the policy error when the stored bytes carry no digest markers', () => {
    expect(prepareArtifactDelivery('<html><head></head><body></body></html>', SNAPSHOT)).toMatchObject({ ok: false, code: 'MARKER_MISSING' });
  });

  it('fails with the policy error when delivery is disabled', async () => {
    const stored = await ingested(PLAIN_HTML);
    expect(prepareArtifactDelivery(stored, { ...SNAPSHOT, deliveryMode: 'disabled' })).toMatchObject({ ok: false, code: 'DELIVERY_DISABLED' });
  });
});

describe('insertArtifactNavigationGuard', () => {
  async function parsedHead(html: string) {
    const stored = await ingested(html);
    const result = prepareArtifactDelivery(stored, SNAPSHOT);
    if (!result.ok) throw new Error(`unexpected ${result.code}`);
    const { parse } = loadParse5Runtime();
    const nodes = [...walkArtifactTree(parse(result.body))];
    const head = nodes.find((node) => 'tagName' in node && node.tagName === 'head');
    if (!head || !('childNodes' in head)) throw new Error('no head');
    return { stored, body: result.body, nodes, head };
  }

  it('places the guard once, after the digest markers and before the stored body links are parsed', async () => {
    const { head, nodes } = await parsedHead('<!doctype html><html><head><title>t</title></head><body><a href="/team/guide">x</a></body></html>');
    const names = head.childNodes.map((node) => ('tagName' in node ? node.tagName : '#'));
    expect(names.at(-1)).toBe('script');
    expect(names.filter((name) => name === 'script')).toHaveLength(1);
    const lastTwoBefore = head.childNodes.slice(-3, -1).map((node) => ('attrs' in node ? node.attrs.find((attr) => attr.name === 'name')?.value : null));
    expect(lastTwoBefore.every((value) => typeof value === 'string' && value.startsWith('crowi'))).toBe(true);
    const guard = head.childNodes.at(-1);
    const text = guard && 'childNodes' in guard ? guard.childNodes.map((node) => ('value' in node ? node.value : '')).join('') : null;
    expect(text).toBe(ARTIFACT_NAVIGATION_GUARD_SCRIPT);
    const guardIndex = nodes.indexOf(guard as (typeof nodes)[number]);
    const linkIndex = nodes.findIndex((node) => 'tagName' in node && node.tagName === 'a');
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(linkIndex).toBeGreaterThan(guardIndex);
  });

  it('delivers a body whose comments precede the doctype', async () => {
    const stored = await ingested(`<!-- a --><!-- b --><!doctype html>${PLAIN_HTML.replace('<!doctype html>', '')}`);
    const result = prepareArtifactDelivery(stored, SNAPSHOT);
    if (!result.ok) throw new Error(`unexpected ${result.code}`);
    expect(result.body.startsWith('<!--')).toBe(true);
    expect(result.body).toContain(guardTag);
    expect(result.body.endsWith(bridgeTag)).toBe(true);
    expect(result.body.split(guardTag)).toHaveLength(2);
  });

  it('only splits the stored body at the given index', () => {
    expect(insertArtifactNavigationGuard('abc</head>def', 3)).toBe(`abc${guardTag}</head>def`);
  });

  it('fails closed without the markers', () => {
    expect(prepareArtifactDelivery('<html><head></head><body></body></html>', SNAPSHOT)).toMatchObject({ ok: false, code: 'MARKER_MISSING' });
  });

  it('fails closed on a duplicated or misplaced marker with the existing error codes', async () => {
    const stored = await ingested(PLAIN_HTML);
    const marker = stored.slice(stored.indexOf('<meta content='), stored.indexOf('</head>'));
    expect(
      prepareArtifactDelivery(
        stored.replace('</head>', () => `${marker}</head>`),
        SNAPSHOT,
      ),
    ).toMatchObject({ ok: false, code: 'MARKER_DUPLICATE' });
    expect(
      prepareArtifactDelivery(
        stored.replace('</head>', () => '<!-- x --></head>'),
        SNAPSHOT,
      ),
    ).toMatchObject({ ok: false, code: 'MARKER_MALFORMED' });
  });
});

describe('appendArtifactFrameBridge', () => {
  it.each([
    ['a plain document', PLAIN_HTML],
    ['a document whose trailing comment contains "</body>"', '<!doctype html><html><head><title>t</title></head><body><p>hi</p></body><!-- </body> --></html>'],
  ])('%s parses with the frame bridge as the last child of <body>, text unchanged', async (_label, html) => {
    const { parse } = loadParse5Runtime();
    const document = parse(appendArtifactFrameBridge(await ingested(html)));
    const body = [...walkArtifactTree(document)].find((node) => 'tagName' in node && node.tagName === 'body');
    const last = body && 'childNodes' in body ? body.childNodes.at(-1) : undefined;
    expect(last && 'tagName' in last ? last.tagName : null).toBe('script');
    const text = last && 'childNodes' in last ? last.childNodes.map((node) => ('value' in node ? node.value : '')).join('') : null;
    expect(text).toBe(ARTIFACT_FRAME_BRIDGE_SCRIPT);
  });
});

describe.each([
  ['ARTIFACT_FRAME_BRIDGE_SCRIPT', ARTIFACT_FRAME_BRIDGE_SCRIPT],
  ['ARTIFACT_NAVIGATION_GUARD_SCRIPT', ARTIFACT_NAVIGATION_GUARD_SCRIPT],
])('%s', (_name, script) => {
  it('cannot end its own <script> element early or open a comment, which would change the hashed text', () => {
    expect(script.toLowerCase()).not.toContain('</script');
    expect(script).not.toContain('<!--');
  });
});

/**
 * Runs the frame bridge against hand-driven layout numbers. `content` is the
 * document's own height; `frame` is the iframe height (= `innerHeight`);
 * `scrollbar` is a horizontal scrollbar's thickness, which `clientHeight`
 * loses. `vhExtra` models a `min-height: 100vh` body with that much padding
 * on top: the document is then never shorter than the frame plus `vhExtra`.
 * `vhScale` models a document that is that many viewports tall (plus `vhExtra`),
 * so its overflow grows with every frame resize instead of staying fixed.
 */
function runBridge(initial: { content: number; frame: number; scrollbar?: number; vhExtra?: number; vhScale?: number }) {
  const layout = { scrollbar: 0, vhExtra: undefined as number | undefined, vhScale: undefined as number | undefined, ...initial };
  const posted: number[] = [];
  let escapes = 0;
  let observerCallback: (() => void) | null = null;
  let mutationCallback: (() => void) | null = null;
  let mutationOptions: MutationObserverInit | null = null;
  let loadListener: (() => void) | null = null;
  const keydownListeners: ((event: { key: string; defaultPrevented: boolean }) => void)[] = [];
  const timers: (() => void)[] = [];

  const contentHeight = () => {
    if (layout.vhScale !== undefined) return Math.ceil(layout.frame * layout.vhScale) + (layout.vhExtra ?? 0);
    return layout.vhExtra === undefined ? layout.content : Math.max(layout.frame, layout.content) + layout.vhExtra;
  };
  const scroller = {
    get clientHeight() {
      return layout.frame - layout.scrollbar;
    },
    get scrollHeight() {
      return Math.max(contentHeight(), layout.frame - layout.scrollbar);
    },
  };
  const target = {
    postMessage: (message: { type: string; height?: number }) => {
      if (message.type === ARTIFACT_ESCAPE_MESSAGE_TYPE) escapes += 1;
      else {
        expect(message.type).toBe(ARTIFACT_HEIGHT_MESSAGE_TYPE);
        posted.push(message.height ?? Number.NaN);
      }
    },
  };
  const window = {
    parent: { parent: target },
    get innerHeight() {
      return layout.frame;
    },
    addEventListener: (type: string, listener: (event: { key: string; defaultPrevented: boolean }) => void) => {
      if (type === 'load') loadListener = () => listener({ key: '', defaultPrevented: false });
      if (type === 'keydown') keydownListeners.push(listener);
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

  new Function('window', 'document', 'ResizeObserver', 'MutationObserver', 'setTimeout', ARTIFACT_FRAME_BRIDGE_SCRIPT)(
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
  // `handledByArtifact` stands for one of the artifact's own listeners,
  // registered after the bridge, cancelling the key once the bridge has
  // already seen it.
  const press = (key: string, { handledByArtifact = false } = {}) => {
    const event = { key, defaultPrevented: false };
    for (const listener of keydownListeners) listener(event);
    if (handledByArtifact) event.defaultPrevented = true;
  };
  // What the page does on a report: resize the frame, which re-lays the
  // document out and fires the observer again.
  const applyLastReport = () => {
    layout.frame = posted.at(-1) ?? layout.frame;
    fire();
  };
  return { layout, posted, escapes: () => escapes, fire, mutate, load, press, runTimers, mutationOptions: () => mutationOptions, applyLastReport };
}

describe('the frame bridge reporting height from inside the artifact', () => {
  it('reports the content height and stays quiet once the frame fits it', () => {
    const bridge = runBridge({ content: 3000, frame: 630 });
    bridge.fire();
    expect(bridge.posted).toEqual([3000]);
    bridge.applyLastReport();
    expect(bridge.posted).toEqual([3000]);
  });

  it('reports a shorter height when the content shrinks below the frame', () => {
    const bridge = runBridge({ content: 3000, frame: 630 });
    bridge.fire();
    bridge.applyLastReport();
    bridge.layout.content = 1200;
    bridge.fire();
    expect(bridge.posted).toEqual([3000, 1200]);
  });

  it('adds a horizontal scrollbar back so the content fits above it', () => {
    const bridge = runBridge({ content: 3000, frame: 630, scrollbar: 15 });
    bridge.fire();
    expect(bridge.posted).toEqual([3015]);
    bridge.applyLastReport();
    expect(bridge.posted).toEqual([3015]);
  });

  it('re-measures after a DOM change that resizes neither observed box (content taken out of flow)', () => {
    const bridge = runBridge({ content: 3000, frame: 630 });
    bridge.fire();
    bridge.applyLastReport();
    // An absolutely positioned panel grows: the scroll height changes, the
    // root and body boxes do not, so no resize notification arrives.
    bridge.layout.content = 4000;
    bridge.mutate();
    bridge.mutate();
    expect(bridge.posted).toEqual([3000]);
    bridge.runTimers();
    expect(bridge.posted).toEqual([3000, 4000]);
    expect(bridge.mutationOptions()).toEqual({ attributes: true, characterData: true, childList: true, subtree: true });
  });

  it('re-measures once the document has finished loading', () => {
    const bridge = runBridge({ content: 3000, frame: 630 });
    bridge.fire();
    bridge.applyLastReport();
    bridge.layout.content = 3500;
    bridge.load();
    bridge.runTimers();
    expect(bridge.posted).toEqual([3000, 3500]);
  });

  it('stops growing a document that is sized from the viewport instead of chasing it forever', () => {
    const bridge = runBridge({ content: 0, frame: 630, vhExtra: 48 });
    bridge.fire();
    for (let i = 0; i < 5; i++) bridge.applyLastReport();
    expect(bridge.posted).toEqual([678]);
  });

  it('still reports a real content change after withholding a viewport-driven one', () => {
    const bridge = runBridge({ content: 0, frame: 630, vhExtra: 48 });
    bridge.fire();
    bridge.applyLastReport();
    bridge.layout.content = 3000;
    bridge.fire();
    for (let i = 0; i < 5; i++) bridge.applyLastReport();
    // Grows to the content, then withholds the viewport-driven step after it.
    expect(bridge.posted).toEqual([678, 3048, 3096]);
  });

  it('stops a document whose content scales with the viewport instead of growing to the cap', () => {
    const bridge = runBridge({ content: 0, frame: 630, vhScale: 3, vhExtra: 16 });
    bridge.fire();
    for (let i = 0; i < 20; i++) bridge.applyLastReport();
    expect(bridge.posted).toHaveLength(1);
    expect(bridge.posted.at(-1)).toBeLessThan(MAX_ARTIFACT_FRAME_HEIGHT);
  });

  it('stops a document that is slightly taller than the viewport at every size', () => {
    const bridge = runBridge({ content: 0, frame: 630, vhScale: 1.1 });
    bridge.fire();
    for (let i = 0; i < 100; i++) bridge.applyLastReport();
    expect(bridge.posted).toHaveLength(1);
    expect(bridge.posted.at(-1)).toBeLessThan(MAX_ARTIFACT_FRAME_HEIGHT);
  });

  it.each([
    ['100vh + 40px', { vhExtra: 40 }],
    ['3 x 100vh + 16px', { vhScale: 3, vhExtra: 16 }],
  ])('keeps withholding when a mutation timer re-measures the same viewport (%s)', (_label, sizing) => {
    const bridge = runBridge({ content: 0, frame: 630, ...sizing });
    bridge.fire();
    for (let i = 0; i < 10; i++) {
      bridge.applyLastReport();
      bridge.mutate();
      bridge.runTimers();
      bridge.load();
      bridge.runTimers();
    }
    expect(bridge.posted).toHaveLength(1);
  });

  it.each([
    ['100vh + 40px', { vhExtra: 40 }],
    ['3 x 100vh + 16px', { vhScale: 3, vhExtra: 16 }],
  ])('does not ratchet the height after maximize and restore (%s)', (_label, sizing) => {
    const bridge = runBridge({ content: 0, frame: 630, ...sizing });
    bridge.fire();
    bridge.applyLastReport();
    const settled = bridge.layout.frame;
    // Maximize and restore resize the frame without a report from the artifact.
    for (const frame of [1400, settled, 900, settled]) {
      bridge.layout.frame = frame;
      bridge.fire();
    }
    expect(bridge.posted).toHaveLength(1);
    expect(bridge.layout.frame).toBe(settled);
  });

  it('reports a large out-of-flow increase once a measurement has settled the new viewport', () => {
    const bridge = runBridge({ content: 2400, frame: 630 });
    bridge.fire();
    expect(bridge.posted).toEqual([2400]);
    bridge.layout.frame = 2400;
    bridge.mutate();
    bridge.runTimers();
    bridge.layout.content = 8400;
    bridge.mutate();
    bridge.runTimers();
    expect(bridge.posted).toEqual([2400, 8400]);
  });
});

describe('the frame bridge forwarding Escape from inside the artifact', () => {
  it('forwards Escape to the page once the artifact has had its turn at it', () => {
    const bridge = runBridge({ content: 3000, frame: 630 });
    bridge.press('Escape');
    expect(bridge.escapes()).toBe(0);
    bridge.runTimers();
    expect(bridge.escapes()).toBe(1);
  });

  it('keeps an Escape the artifact handled itself', () => {
    const bridge = runBridge({ content: 3000, frame: 630 });
    bridge.press('Escape', { handledByArtifact: true });
    bridge.runTimers();
    expect(bridge.escapes()).toBe(0);
  });

  it('forwards no other key', () => {
    const bridge = runBridge({ content: 3000, frame: 630 });
    bridge.press('Enter');
    bridge.runTimers();
    expect(bridge.escapes()).toBe(0);
  });
});

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';
const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';

type FakeEl = {
  nodeType: number;
  namespaceURI: string;
  localName: string;
  isContentEditable?: boolean;
  parentNode: FakeEl | null;
  host?: FakeEl;
  hasAttribute: (name: string) => boolean;
  getAttribute: (name: string) => string | null;
};

function el(localName: string, attrs: Record<string, string> = {}, options: { ns?: string; editable?: boolean; parent?: FakeEl | null } = {}): FakeEl {
  return {
    nodeType: 1,
    namespaceURI: options.ns ?? HTML_NS,
    localName,
    isContentEditable: options.editable,
    parentNode: options.parent ?? null,
    hasAttribute: (name) => name in attrs,
    getAttribute: (name) => attrs[name] ?? null,
  };
}

type EventInit = {
  button?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  isTrusted?: boolean;
  defaultPrevented?: boolean;
};

/** Runs the guard against a fake document; `path` is innermost-first, as `composedPath()` returns it. */
function runGuard({ standalone = false, throwOnPost = false }: { standalone?: boolean; throwOnPost?: boolean } = {}) {
  const listeners: Record<string, { fn: (event: unknown) => void; capture: boolean }[]> = {};
  const messages: { type: string; href: string; disposition: string }[] = [];
  const top = {
    postMessage: (message: { type: string; href: string; disposition: string }) => {
      if (throwOnPost) throw new Error('closed');
      messages.push(message);
    },
  };
  const window: { parent: unknown } = { parent: { parent: top } };
  if (standalone) window.parent = window;
  const document = {
    addEventListener: (type: string, fn: (event: unknown) => void, capture: boolean) => {
      (listeners[type] ??= []).push({ fn, capture });
    },
  };
  new Function('window', 'document', ARTIFACT_NAVIGATION_GUARD_SCRIPT)(window, document);

  function dispatch(type: string, path: FakeEl[], init: EventInit = {}, options: { withoutComposedPath?: boolean } = {}) {
    const event = {
      type,
      target: path[0],
      composedPath: options.withoutComposedPath ? undefined : () => path,
      isTrusted: init.isTrusted ?? true,
      button: init.button ?? 0,
      metaKey: init.metaKey ?? false,
      ctrlKey: init.ctrlKey ?? false,
      shiftKey: init.shiftKey ?? false,
      altKey: init.altKey ?? false,
      defaultPrevented: init.defaultPrevented ?? false,
      preventDefault() {
        this.defaultPrevented = true;
        prevented += 1;
      },
    };
    let prevented = 0;
    for (const { fn } of listeners[type] ?? []) fn(event);
    return { prevented: prevented > 0, event };
  }
  return { listeners, messages, dispatch };
}

describe('the navigation guard', () => {
  const link = (attrs: Record<string, string> = {}) => el('a', { href: '/team/guide', ...attrs });

  it('registers one capture listener each for click, auxclick and contextmenu', () => {
    const { listeners } = runGuard();
    expect(Object.keys(listeners).sort()).toEqual(['auxclick', 'click', 'contextmenu']);
    for (const entries of Object.values(listeners)) {
      expect(entries).toHaveLength(1);
      expect(entries[0].capture).toBe(true);
    }
  });

  it('E-7: a trusted primary click on a page link posts the raw href as same-tab and stops the native navigation', () => {
    const guard = runGuard();
    const { prevented } = guard.dispatch('click', [link()]);
    expect(prevented).toBe(true);
    expect(guard.messages).toEqual([{ type: ARTIFACT_NAVIGATE_MESSAGE_TYPE, href: '/team/guide', disposition: 'same-tab' }]);
  });

  it('reads the raw attribute rather than a resolved URL, and finds the link through nested elements', () => {
    const guard = runGuard();
    const anchor = el('a', { href: '../guide#overview' });
    const span = el('span', {}, { parent: anchor });
    guard.dispatch('click', [span, anchor]);
    expect(guard.messages.map((m) => m.href)).toEqual(['../guide#overview']);
  });

  it('recognises an area (image map) link', () => {
    const guard = runGuard();
    guard.dispatch('click', [el('area', { href: 'guide' })]);
    expect(guard.messages).toEqual([{ type: ARTIFACT_NAVIGATE_MESSAGE_TYPE, href: 'guide', disposition: 'same-tab' }]);
  });

  it('recognises a link inside an open shadow root through the composed path', () => {
    const guard = runGuard();
    const anchor = el('a', { href: '/x' });
    const shadowRoot = { nodeType: 11 } as unknown as FakeEl;
    const host = el('div');
    guard.dispatch('click', [anchor, shadowRoot, host]);
    expect(guard.messages).toHaveLength(1);
  });

  it('falls back to walking parents (and shadow hosts) when composedPath is unavailable', () => {
    const guard = runGuard();
    const host = el('div');
    const anchor = el('a', { href: '/x' });
    const shadowRoot = { nodeType: 11, parentNode: null, host } as unknown as FakeEl;
    const inner = el('span', {}, { parent: anchor });
    anchor.parentNode = shadowRoot;
    expect(guard.dispatch('click', [inner], {}, { withoutComposedPath: true }).prevented).toBe(true);
    expect(guard.messages).toHaveLength(1);
  });

  it('E-6: cmd/ctrl or target=_blank is a new-tab request', () => {
    const guard = runGuard();
    guard.dispatch('click', [link()], { metaKey: true });
    guard.dispatch('click', [link()], { ctrlKey: true });
    guard.dispatch('click', [link({ target: '_BLANK' })]);
    expect(guard.messages.map((m) => m.disposition)).toEqual(['new-tab', 'new-tab', 'new-tab']);
  });

  it('E-3: a plain fragment link keeps its native in-document navigation and posts nothing', () => {
    const guard = runGuard();
    for (const href of ['#section', '  #section ']) {
      expect(guard.dispatch('click', [el('a', { href })]).prevented).toBe(false);
    }
    expect(guard.dispatch('click', [el('a', { href: '#s', target: '_self' })]).prevented).toBe(false);
    expect(guard.messages).toEqual([]);
  });

  it('E-4: any other operation on a fragment link is cancelled without a message', () => {
    const guard = runGuard();
    const frag = () => el('a', { href: '#s' });
    expect(guard.dispatch('click', [frag()], { metaKey: true }).prevented).toBe(true);
    expect(guard.dispatch('click', [frag()], { ctrlKey: true }).prevented).toBe(true);
    expect(guard.dispatch('click', [frag()], { button: 1 }).prevented).toBe(true);
    expect(guard.dispatch('click', [el('a', { href: '#s', target: '_blank' })]).prevented).toBe(true);
    expect(guard.dispatch('contextmenu', [frag()]).prevented).toBe(true);
    expect(guard.dispatch('auxclick', [frag()], { button: 1 }).prevented).toBe(true);
    expect(guard.messages).toEqual([]);
  });

  it('E-1: contextmenu and auxclick on a page link are cancelled without a message', () => {
    const guard = runGuard();
    expect(guard.dispatch('contextmenu', [link()], { button: 2 }).prevented).toBe(true);
    expect(guard.dispatch('auxclick', [link()], { button: 1 }).prevented).toBe(true);
    expect(guard.dispatch('auxclick', [link()], { button: 2 }).prevented).toBe(true);
    expect(guard.messages).toEqual([]);
  });

  it('E-2: download, shift, alt and named / _top / _parent targets are cancelled without a message', () => {
    const guard = runGuard();
    expect(guard.dispatch('click', [link({ download: '' })]).prevented).toBe(true);
    expect(guard.dispatch('click', [link()], { shiftKey: true }).prevented).toBe(true);
    expect(guard.dispatch('click', [link()], { altKey: true }).prevented).toBe(true);
    for (const target of ['_top', '_parent', 'named']) expect(guard.dispatch('click', [link({ target })]).prevented).toBe(true);
    expect(guard.messages).toEqual([]);
  });

  it('E-5: an untrusted click, a non-primary click or an out-of-range href is cancelled without a message', () => {
    const guard = runGuard();
    expect(guard.dispatch('click', [link()], { isTrusted: false }).prevented).toBe(true);
    expect(guard.dispatch('click', [link()], { button: 1 }).prevented).toBe(true);
    expect(guard.dispatch('click', [el('a', { href: `/${'a'.repeat(ARTIFACT_LINK_MAX_LENGTH)}` })]).prevented).toBe(true);
    expect(guard.dispatch('click', [el('a', { href: '' })]).prevented).toBe(true);
    expect(guard.messages).toEqual([]);
  });

  it('E-5: an event an earlier capture listener already cancelled is cancelled again but not reported', () => {
    const guard = runGuard();
    guard.dispatch('click', [link()], { defaultPrevented: true });
    expect(guard.messages).toEqual([]);
  });

  it('a later preventDefault by the author cannot recall the message already sent', () => {
    const guard = runGuard();
    const { event } = guard.dispatch('click', [link()]);
    event.preventDefault();
    expect(guard.messages).toHaveLength(1);
  });

  it('E-0: stops at an element with its own activation behaviour inside the link: no cancel, no message', () => {
    const guard = runGuard();
    const anchor = link();
    const parent = { parent: anchor };
    const inner: FakeEl[] = [
      el('input', { type: 'checkbox' }, parent),
      el('label', {}, parent),
      el('summary', {}, parent),
      el('select', {}, parent),
      el('textarea', {}, parent),
      el('a', { href: '/svg' }, { ns: SVG_NS, ...parent }),
      el('a', { href: '/math' }, { ns: MATHML_NS, ...parent }),
      el('span', {}, { editable: true, ...parent }),
    ];
    for (const target of inner) {
      expect(guard.dispatch('click', [target, anchor]).prevented).toBe(false);
      // Only the target is handed over, so the parent walk is what would reach the anchor.
      expect(guard.dispatch('click', [target], {}, { withoutComposedPath: true }).prevented).toBe(false);
    }
    expect(guard.messages).toEqual([]);

    // Control: the same fallback walk does reach the anchor from a plain child, so the stops above are real.
    expect(guard.dispatch('click', [el('span', {}, parent)], {}, { withoutComposedPath: true }).prevented).toBe(true);
    expect(guard.messages).toHaveLength(1);
  });

  it('E-0 in the fallback walk also stops at a control nested deeper inside the link', () => {
    const guard = runGuard();
    const anchor = link();
    const label = el('label', {}, { parent: anchor });
    const span = el('span', {}, { parent: label });
    expect(guard.dispatch('click', [span], {}, { withoutComposedPath: true }).prevented).toBe(false);
    expect(guard.messages).toEqual([]);
  });

  it('E-0 does not apply to a control that is outside the link', () => {
    const guard = runGuard();
    guard.dispatch('click', [link(), el('label')]);
    expect(guard.messages).toHaveLength(1);
  });

  it('ignores clicks that are not on a link, and anchors without an href', () => {
    const guard = runGuard();
    expect(guard.dispatch('click', [el('div')]).prevented).toBe(false);
    expect(guard.dispatch('click', [el('a', { name: 'x' })]).prevented).toBe(false);
    expect(guard.messages).toEqual([]);
  });

  it('on a standalone document it cancels the navigation and posts nothing', () => {
    const guard = runGuard({ standalone: true });
    expect(guard.dispatch('click', [link()]).prevented).toBe(true);
    expect(guard.messages).toEqual([]);
  });

  it('swallows a postMessage failure', () => {
    const guard = runGuard({ throwOnPost: true });
    expect(() => guard.dispatch('click', [link()])).not.toThrow();
  });
});
