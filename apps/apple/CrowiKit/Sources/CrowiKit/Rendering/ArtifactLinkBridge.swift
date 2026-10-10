import Foundation

/// The script that hands the app a wiki link the reader tapped inside an
/// HTML artifact.
///
/// On the web, the server's navigation guard (inserted into every delivered
/// artifact) turns such a tap into a message to the wiki page that frames
/// the artifact. The app shows the artifact without such a page, so that
/// message has nowhere to go and the guard drops the tap.
///
/// This script takes the guard's place in the app. It runs in a script world
/// of its own: the artifact's scripts share the DOM with it but cannot see
/// it, nor the message handler it posts to, so they cannot send the app a
/// link of their own choosing. Only a real tap (`isTrusted`) is forwarded,
/// which is what lets the app follow the link without the web's
/// user-activation checks and confirmation prompt — those exist because an
/// artifact's script can post the guard's message itself.
///
/// Which tap counts as a link, and which ones it swallows, follows the
/// guard exactly, so the same tap does the same thing on both clients. It
/// also cancels the native navigation itself rather than relying on the
/// guard being present: an uncancelled tap would navigate the artifact's
/// own frame to a URL on the delivery origin.
///
/// What arrives at the handler is the raw `href` and nothing else; whether
/// it may be followed is `ArtifactPageLink`'s decision.
public enum ArtifactLinkBridge {
    public static let worldName = "crowi-artifact-links"
    public static let handlerName = "crowiArtifactLink"

    public static let script = """
        (function () {
          var HTML_NS = 'http://www.w3.org/1999/xhtml';
          var BLOCKING_TAGS = { input: 1, label: 1, select: 1, textarea: 1, summary: 1 };
          function eventPath(event) {
            if (typeof event.composedPath === 'function') {
              var composed = event.composedPath();
              if (composed && composed.length > 0) return composed;
            }
            var path = [];
            for (var node = event.target; node; node = node.parentNode || node.host) path.push(node);
            return path;
          }
          function findNavigationLink(event) {
            var path = eventPath(event);
            for (var i = 0; i < path.length; i++) {
              var el = path[i];
              if (!el || el.nodeType !== 1) continue;
              var isHtml = el.namespaceURI === HTML_NS;
              if (isHtml ? BLOCKING_TAGS[el.localName] === 1 : el.localName === 'a') return null;
              if (el.isContentEditable === true) return null;
              if (isHtml && (el.localName === 'a' || el.localName === 'area') && el.hasAttribute('href')) return el;
            }
            return null;
          }
          function handleLinkActivation(event) {
            var alreadyPrevented = event.defaultPrevented;
            var link = findNavigationLink(event);
            if (!link) return;
            var href = link.getAttribute('href');
            var fragmentOnly = href.replace(/^[\\t\\n\\f\\r ]+|[\\t\\n\\f\\r ]+$/g, '').charAt(0) === '#';
            var linkTarget = (link.getAttribute('target') || '').toLowerCase();
            var plainTarget = linkTarget === '' || linkTarget === '_self';
            if (event.type !== 'click') {
              event.preventDefault();
              return;
            }
            if (link.hasAttribute('download') || event.shiftKey || event.altKey || (!plainTarget && linkTarget !== '_blank')) {
              event.preventDefault();
              return;
            }
            if (fragmentOnly) {
              if (!(event.button === 0 && !event.metaKey && !event.ctrlKey && plainTarget)) event.preventDefault();
              return;
            }
            event.preventDefault();
            if (!event.isTrusted || alreadyPrevented || event.button !== 0 || href.length < 1 || href.length > \(ArtifactPageLink.maxLength)) return;
            try {
              window.webkit.messageHandlers.\(handlerName).postMessage(href);
            } catch (error) {}
          }
          document.addEventListener('click', handleLinkActivation, true);
          document.addEventListener('auxclick', handleLinkActivation, true);
          document.addEventListener('contextmenu', handleLinkActivation, true);
        })();
        """

    /// What the handler accepts from the script: a string within the link
    /// limit. Anything else is dropped before it reaches the resolver — the
    /// script is the only sender, but nothing is assumed about the body.
    public static func acceptedHref(from body: Any) -> String? {
        guard let href = body as? String, !href.isEmpty, href.utf16.count <= ArtifactPageLink.maxLength else { return nil }
        return href
    }
}
