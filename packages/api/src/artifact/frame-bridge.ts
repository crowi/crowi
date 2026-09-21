/**
 * The one piece of code delivery adds to a served artifact: a fixed inline
 * script that tells the wiki page what only the artifact's own document can
 * see. It reports the document's content height, so the page can grow the
 * frame to fit instead of scrolling inside it, and it forwards Escape, so a
 * maximized frame can be restored while focus is inside it. The artifact runs
 * sandboxed on an opaque origin, so the page can neither measure its layout
 * nor hear its key events.
 *
 * The script is a constant, so its digest is too: delivery authorises it
 * by that digest alongside the author's own inline scripts
 * (`prepareArtifactDelivery`), and the stored bytes stay the author's (the
 * download route serves them untouched).
 */
import { ARTIFACT_ESCAPE_MESSAGE_TYPE, ARTIFACT_HEIGHT_MESSAGE_TYPE } from '@crowi/api-contract';

import { sha256DigestToken } from './csp';

// Posts to `parent.parent` because the artifact sits two frames below the
// wiki page (page → `/_artifact-frame` → artifact). `clientHeight` of the
// scrolling element is the viewport minus any horizontal scrollbar, which
// the reported height adds back so the content fits above the bar.
//
// A document that grows with the viewport (`min-height: 100vh` plus padding,
// a stack of `100vh` slides, `min-height: 110vh`) is still overflowing after
// the frame grows to fit it, so following it never converges. A report is
// withheld when the viewport has grown since the last report and the overflow
// has not shrunk; the rest stays scrollable inside the frame. What was
// withheld is remembered apart from what was sent: the same measurement taken
// again at the same viewport (the mutation timer and `load` re-measure without
// the viewport moving) must stay withheld, which comparing against the last
// report alone cannot tell from a real change. A different height at the same
// viewport is a real change and is reported. A duplicate of the last report
// still refreshes the viewport and overflow it is compared against, so a
// frame that has since grown is not judged against its pre-growth baseline.
//
// Known gap: if content leaves the flow and grows by more than the previous
// overflow before any measurement is taken at the newly grown frame size, that
// growth reads like the viewport-driven kind and is withheld. The content stays
// scrollable. It is reported again only once the viewport changes, or a
// measurement at the same viewport reads a height other than the withheld one;
// a measurement at an unchanged viewport and the same height stays withheld.
//
// Content taken out of flow (absolutely positioned, transformed) changes the
// scroll height without resizing the root or body box, so the resize
// observer alone misses it; DOM changes and the end of loading schedule a
// re-measure as well. That re-measure runs on a coarse timer rather than in
// an animation frame: a read there forces layout ahead of the frame's own,
// which an artifact animating its DOM would pay every frame, while a timer
// reads between frames, when layout is usually clean.
//
// Escape is forwarded only if the artifact did not cancel it. The check waits
// for a timer because the artifact may have its own listener registered after
// this one, which cancels the key only once this listener has already run.
export const ARTIFACT_FRAME_BRIDGE_SCRIPT = `(function () {
  var target = window.parent.parent;
  var root = document.documentElement;
  var sentHeight = -1;
  var sentOverflow = 0;
  var sentViewport = 0;
  var withheldHeight = -1;
  var withheldViewport = -1;
  function report() {
    var scroller = document.scrollingElement || root;
    var viewport = scroller.clientHeight;
    var content = Math.ceil(Math.max(root.getBoundingClientRect().height, scroller.scrollHeight > viewport ? scroller.scrollHeight : 0));
    var overflow = content - viewport;
    var height = content + window.innerHeight - viewport;
    if (height === sentHeight) {
      sentOverflow = overflow;
      sentViewport = viewport;
      return;
    }
    if (viewport === withheldViewport) {
      if (height === withheldHeight) return;
    } else if (sentHeight >= 0 && overflow > 0 && overflow >= sentOverflow && viewport > sentViewport) {
      withheldHeight = height;
      withheldViewport = viewport;
      return;
    }
    sentHeight = height;
    sentOverflow = overflow;
    sentViewport = viewport;
    withheldHeight = -1;
    withheldViewport = -1;
    target.postMessage({ type: ${JSON.stringify(ARTIFACT_HEIGHT_MESSAGE_TYPE)}, height: height }, '*');
  }
  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      report();
    }, 100);
  }
  var observer = new ResizeObserver(report);
  observer.observe(root);
  if (document.body) observer.observe(document.body);
  new MutationObserver(schedule).observe(root, { attributes: true, characterData: true, childList: true, subtree: true });
  window.addEventListener('load', schedule);
  window.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    setTimeout(function () {
      if (!event.defaultPrevented) target.postMessage({ type: ${JSON.stringify(ARTIFACT_ESCAPE_MESSAGE_TYPE)} }, '*');
    }, 0);
  });
})();`;

/** CSP hash-source token (without quotes) matching exactly {@link ARTIFACT_FRAME_BRIDGE_SCRIPT}. */
export const ARTIFACT_FRAME_BRIDGE_DIGEST = sha256DigestToken(ARTIFACT_FRAME_BRIDGE_SCRIPT);

/**
 * Appended after the whole stored document rather than spliced before
 * `</body>`: content after `</html>` makes the parser reopen `<body>`, so
 * the script lands as body's last child whatever the document ends with,
 * and no string search can be fooled by a `</body>` inside a comment.
 */
export function appendArtifactFrameBridge(body: string): string {
  return `${body}<script>${ARTIFACT_FRAME_BRIDGE_SCRIPT}</script>`;
}
