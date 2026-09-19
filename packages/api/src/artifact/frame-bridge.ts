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
import { createHash } from 'node:crypto';

import { ARTIFACT_ESCAPE_MESSAGE_TYPE, ARTIFACT_HEIGHT_MESSAGE_TYPE } from '@crowi/api-contract';

// Posts to `parent.parent` because the artifact sits two frames below the
// wiki page (page → `/_artifact-frame` → artifact). `clientHeight` of the
// scrolling element is the viewport minus any horizontal scrollbar, which
// the reported height adds back so the content fits above the bar.
//
// A document sized from the viewport (`min-height: 100vh` plus padding, say)
// overflows by the same amount at every frame height, so growing the frame
// never converges. When the viewport has grown since the last report and the
// overflow is unchanged, the report is withheld and the rest stays scrollable
// inside the frame.
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
  function report() {
    var scroller = document.scrollingElement || root;
    var viewport = scroller.clientHeight;
    var content = Math.ceil(Math.max(root.getBoundingClientRect().height, scroller.scrollHeight > viewport ? scroller.scrollHeight : 0));
    var overflow = content - viewport;
    var height = content + window.innerHeight - viewport;
    if (height === sentHeight) return;
    if (overflow > 0 && overflow === sentOverflow && viewport > sentViewport) return;
    sentHeight = height;
    sentOverflow = overflow;
    sentViewport = viewport;
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
export const ARTIFACT_FRAME_BRIDGE_DIGEST = `sha256-${createHash('sha256').update(ARTIFACT_FRAME_BRIDGE_SCRIPT, 'utf8').digest('base64')}`;

/**
 * Appended after the whole stored document rather than spliced before
 * `</body>`: content after `</html>` makes the parser reopen `<body>`, so
 * the script lands as body's last child whatever the document ends with,
 * and no string search can be fooled by a `</body>` inside a comment.
 */
export function appendArtifactFrameBridge(body: string): string {
  return `${body}<script>${ARTIFACT_FRAME_BRIDGE_SCRIPT}</script>`;
}
