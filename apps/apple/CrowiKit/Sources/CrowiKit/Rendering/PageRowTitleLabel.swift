import SwiftUI

/// feature-ios-page-display-name — the shared two-line page title every FLAT
/// list row shows: the page's display name (its basename, with a trailing
/// date hierarchy folded into it) as the scannable hero, its parent directory
/// as a muted second line. Replaces the raw full `page.path` the recency home,
/// the recently-viewed list and the search results used to print.
///
/// ## This is a deliberate SECOND implementation — keep it in step
///
/// The rule is ported from `packages/web/src/lib/page-path.ts:96-134`
/// (`pageDisplayName` / `pageDisplayParent`), whose doc comments are the
/// normative statement of it; the web page list renders the very same two
/// lines from them (`packages/web/src/components/page-list/page-list-item.tsx:91-99`).
/// Swift cannot call that TypeScript util, and the server deliberately does
/// NOT derive the name (`path` is all a client needs — the web's own sidebar
/// tree intentionally shows raw segments instead), so this port is the only
/// way iOS can agree with the web. **If the rule changes on the web side it
/// MUST be changed here too.** The tripwire that makes a one-sided change
/// fail loudly is the expectation table both test suites read:
/// `packages/web/src/lib/__fixtures__/page-display-name.json`
/// (`PageRowTitleLabelTests` here, `page-path.test.ts` there).
///
///     /user/foo/日報/2026/05/23 → 「2026/05/23」under 「/user/foo/日報/」
///     /crowi/rfc/0001-plugin    → 「0001-plugin」 under 「/crowi/rfc/」
///     /foo                      → 「foo」        (root parent → no second line)
///     /                         → 「/」          (no display name → raw path)
///
/// Lives in CrowiKit rather than the App target for the
/// `PageRowMetadataLabel`/`SearchCapabilityToolbarButton` reason: the App
/// target's manifest imports `AppleProductTypes`, which the bare `swift` CLI
/// running `CrowiKitTests` cannot even parse — so the pinned logic and the
/// production view have to be one and the same type here.
public struct PageRowTitleLabel: View {
    private let path: String

    public init(path: String) {
        self.path = path
    }

    /// The hero line. Falls back to the raw `path` when the path has no
    /// display name at all (only the top page `/`), mirroring the web list's
    /// `pageDisplayName(page.path) || page.path`.
    public var titleText: String {
        let name = Self.displayName(for: path)
        return name.isEmpty ? path : name
    }

    /// The muted line's text — always meaningful, but only rendered when
    /// `showsParent` is true.
    public var parentText: String { Self.displayParent(for: path) }

    /// A standalone `/` second line is pure visual noise (the title already
    /// carries the whole path for a root-level page such as `/2026/05/23`),
    /// so the parent slot disappears entirely at root — the web list's
    /// `parentPath !== '/'` gate.
    public var showsParent: Bool { Self.showsParent(parent: parentText) }

    private static func showsParent(parent: String) -> Bool { parent != "/" }

    public var body: some View {
        // Derive the parent once per render and reuse it for both the gate and
        // the muted line — `showsParent` and `parentText` each re-parse `path`
        // for standalone (test) callers, so reading both here would parse it
        // twice (the `PageRowMetadataLabel` precedent).
        let parent = parentText
        VStack(alignment: .leading, spacing: CrowiMetrics.rowLineSpacing) {
            // One line, truncated — the web list's title span is `truncate`
            // (`page-list-item.tsx:113-121`), i.e. a single ellipsised line.
            // SwiftUI would otherwise wrap a long basename across three or
            // more lines, which both breaks the fixed two-line row rhythm and
            // shoves the metadata footer of every neighbouring row around.
            // Nothing is lost: the `Text` still holds the whole name, so
            // VoiceOver reads it untruncated (the counterpart of the web
            // span's `title={page.path}` tooltip).
            Text(titleText)
                .font(CrowiTypography.rowTitle)
                .foregroundStyle(CrowiTheme.foreground)
                .lineLimit(1)
                .truncationMode(.tail)
            if Self.showsParent(parent: parent) {
                // Muted, MONOSPACE, one line, truncated. The monospace face
                // is the design's (`font-family:ui-monospace…` on the row's
                // path line) and now matches the web list's second line too
                // — this label's earlier comment said nothing else in the app
                // rendered paths monospaced, which the visual redesign
                // changed: a path is machine text and reads as such.
                Text(parent)
                    .font(CrowiTypography.rowPath)
                    .foregroundStyle(CrowiTheme.mutedForeground)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        // Rows are `Button` labels: without this the two lines shrink to
        // their intrinsic width and the tap target stops spanning the row.
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

extension PageRowTitleLabel {
    /// Port of `pageDisplayName` (`page-path.ts:109-114`): the last path
    /// segment, except that a trailing run of all-digit segments — Crowi's
    /// date-hierarchy idiom — is returned whole, so a daily note at
    /// `/user/foo/日報/2026/05/23` reads "2026/05/23" and not "23".
    /// `""` for the top page.
    public static func displayName(for path: String) -> String {
        let segments = pathSegments(path)
        guard !segments.isEmpty else { return "" }
        return segments[trailingNumericRunStart(segments)...].joined(separator: "/")
    }

    /// Port of `pageDisplayParent` (`page-path.ts:129-134`): everything in
    /// front of what `displayName(for:)` returned, slash-terminated, or `"/"`
    /// when nothing is left. Pairs with it so that
    /// `displayParent + displayName` reproduces the path (trailing slashes
    /// stripped) for any non-root path.
    public static func displayParent(for path: String) -> String {
        let segments = pathSegments(path)
        guard !segments.isEmpty else { return "/" }
        let start = trailingNumericRunStart(segments)
        guard start > 0 else { return "/" }
        return "/" + segments[..<start].joined(separator: "/") + "/"
    }

    /// `path.split('/').filter(Boolean)` — empty segments (leading, trailing
    /// and repeated slashes) are dropped, which is what
    /// `omittingEmptySubsequences` does by default.
    private static func pathSegments(_ path: String) -> [String] {
        path.split(separator: "/").map(String.init)
    }

    /// The web's `isNumericSegment` is `/^\d+$/`, and JavaScript's `\d` is
    /// **ASCII 0-9 only**. Swift's `Character.isNumber` (and
    /// `CharacterSet.decimalDigits`) also accept full-width `２０２６`, Devanagari
    /// digits and friends, so testing digit-ness the idiomatic Swift way
    /// would silently collapse paths the web leaves alone. Hence the explicit
    /// `isASCII` conjunct — pinned by the `/日報/２０２６` fixture cases.
    private static func isNumericSegment(_ segment: String) -> Bool {
        !segment.isEmpty && segment.allSatisfy { $0.isASCII && $0.isNumber }
    }

    /// Port of `trailingNumericRunStart` (`page-path.ts:85-93`): the index at
    /// which the trailing all-digit run starts, or the last index when the
    /// leaf is not numeric (nothing to collapse).
    private static func trailingNumericRunStart(_ segments: [String]) -> Int {
        guard let last = segments.last else { return 0 }
        guard isNumericSegment(last) else { return segments.count - 1 }
        var start = segments.count - 1
        while start > 0, isNumericSegment(segments[start - 1]) {
            start -= 1
        }
        return start
    }
}
