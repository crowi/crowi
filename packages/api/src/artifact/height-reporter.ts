/**
 * The one piece of code delivery adds to a served artifact: a fixed inline
 * script that reports the document's content height to the wiki page, so
 * the page can grow the frame to fit instead of scrolling inside it. The
 * artifact runs sandboxed on an opaque origin, so nothing outside it can
 * measure its layout — the report has to come from within.
 *
 * The script is a constant, so its digest is too: `csp.ts` authorises it
 * by that digest alongside the author's own inline scripts, and the stored
 * bytes stay the author's (the download route serves them untouched).
 */
import { createHash } from 'node:crypto';

import { ARTIFACT_HEIGHT_MESSAGE_TYPE } from '@crowi/api-contract';

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
export const ARTIFACT_HEIGHT_REPORTER_SCRIPT = `(function () {
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
  var observer = new ResizeObserver(report);
  observer.observe(root);
  if (document.body) observer.observe(document.body);
})();`;

/** CSP hash-source token (without quotes) matching exactly {@link ARTIFACT_HEIGHT_REPORTER_SCRIPT}. */
export const ARTIFACT_HEIGHT_REPORTER_DIGEST = `sha256-${createHash('sha256').update(ARTIFACT_HEIGHT_REPORTER_SCRIPT, 'utf8').digest('base64')}`;

/**
 * Appended after the whole stored document rather than spliced before
 * `</body>`: content after `</html>` makes the parser reopen `<body>`, so
 * the script lands as body's last child whatever the document ends with,
 * and no string search can be fooled by a `</body>` inside a comment.
 */
export function appendArtifactHeightReporter(body: string): string {
  return `${body}<script>${ARTIFACT_HEIGHT_REPORTER_SCRIPT}</script>`;
}
