import Foundation

/// RFC-0016 §6.2 — the ONE shared scheme-allowlist entry point. Consumed by
/// both the wikilink/mention `openURL` interceptor (`WorkspacePageMarkdownView`)
/// and, indirectly, everywhere an image/link URL is resolved before being
/// handed to the renderer — a second, drifted allowlist implementation is
/// exactly the failure mode the architecturalNotes call out to avoid, so
/// this is declared exactly once.
///
/// Allows ONLY `http`, `https`, and a workspace-relative reference (no
/// scheme at all — the caller rebases it against the workspace origin,
/// §6.1). Every custom scheme is inerted UNCONDITIONALLY, including the
/// app's own `crowi-ios://` OAuth-callback scheme (load-bearing: a wiki
/// body containing `[x](crowi-ios://callback?code=…)` must never be
/// tappable — the callback is only ever delivered via ASWAS's
/// `callbackURLScheme` capture, never a tapped link, but this is the
/// belt-and-suspenders §4.1/§6.2 calls for) and the app's own private
/// wikilink/mention pseudo-schemes (`WikiLinkMentionPreprocessor`), which
/// MUST be intercepted and resolved BEFORE this allowlist ever sees them —
/// once past that interception point, this type has no special case for
/// them and would (correctly) inert them like any other custom scheme.
/// `tel:`/`mailto:` are inert in v1 too (OQ-9 pin — opt-in is a future
/// product decision, not this phase's).
public enum SchemeAllowlist {
    /// `true` when `url` is safe to hand to `UIApplication.open` / `Link` /
    /// an image fetch.
    public static func isAllowed(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else {
            // No scheme at all — a workspace-relative reference; the caller
            // rebases it against the workspace origin before fetching (§6.1).
            return true
        }
        return scheme == "http" || scheme == "https"
    }

    /// String-based overload for call sites that only have a raw (possibly
    /// unparseable) URL string from a Markdown link/image destination — an
    /// unparseable string is treated as NOT allowed (fail closed).
    public static func isAllowed(_ urlString: String) -> Bool {
        guard let url = URL(string: urlString) else { return false }
        return isAllowed(url)
    }
}
