import Foundation
import SwiftUI

/// RFC-0015 image display attributes (`feature-ios-phase3-notifications-extensions`)
/// — the parsed, ALREADY-VALIDATED `width`/`height`/`align`/`float` values a
/// `![alt](url){width=60% align=center}` attribute block carries.
///
/// The validation rules are a deliberate SECOND implementation of the
/// server's canonical DROP rule and must stay in lockstep with
/// `packages/api/src/renderer/core/image-attrs.ts` (`validateSize`,
/// `parseAttrBody`, `ALIGN_VALUES`, `FLOAT_VALUES`) — the exact same
/// intentional-duplication stance the web client already takes
/// (`packages/web/src/components/editor/image-display.ts:77-100`), and the
/// same rules RFC-0023 §11 pins for `data-crowi-image-*` client-side
/// re-validation, so this survives the future AST-delivery migration:
///   - `width`/`height`: `<number>%` in `1...100` or `<number>px` in
///     `1...4096`, both CLOSED intervals; anything else (out of range,
///     non-numeric, unit-less) is **DROPPED — never clamped**.
///   - `align`: exactly `left`/`center`/`right` (value case-sensitive, like
///     the server's `Set.has`).
///   - `float`: exactly `left`/`right`.
///   - keys are lowercased before matching (server: `key.toLowerCase()`);
///     unknown keys and malformed tokens are silently ignored; when a key
///     repeats, the last VALID occurrence wins and an invalid repeat does
///     not clear an earlier valid one.
public struct ImageDisplayAttributes: Sendable, Equatable {
    /// A validated size value (`width=`/`height=`), keeping the author's raw
    /// token (`"60%"`, `"12.5%"`, `"500px"`) exactly as written — the server
    /// re-emits the validated value verbatim too, never a normalized number.
    public struct Size: Sendable, Equatable {
        public enum Unit: String, Sendable {
            case percent = "%"
            case pixels = "px"
        }

        public let raw: String
        public let number: Double
        public let unit: Unit

        /// Mirror of `validateSize` (`image-attrs.ts:142-150`). `[0-9]` is
        /// spelled explicitly rather than `\d` because JavaScript's `\d` is
        /// ASCII-only while `NSRegularExpression`'s `\d` also matches
        /// full-width/Devanagari digits — the same divergence
        /// `PageRowTitleLabel.isNumericSegment` already documents and guards.
        private static let sizeRegex = try! NSRegularExpression(pattern: "^([0-9]+(?:\\.[0-9]+)?)(%|px)$")

        public static func validated(_ value: String) -> Size? {
            let nsValue = value as NSString
            guard
                let match = sizeRegex.firstMatch(in: value, range: NSRange(location: 0, length: nsValue.length)),
                match.numberOfRanges == 3,
                let number = Double(nsValue.substring(with: match.range(at: 1))),
                number.isFinite
            else { return nil }
            let unit: Unit = nsValue.substring(with: match.range(at: 2)) == "%" ? .percent : .pixels
            let upperBound: Double = unit == .percent ? 100 : 4096
            guard number >= 1, number <= upperBound else { return nil }
            return Size(raw: value, number: number, unit: unit)
        }

        /// The token embedded in the URL-fragment side-channel below. `%` is
        /// re-spelled as `pct` so the carried fragment never contains a
        /// character `URL(string:)` would reject or percent-escape — the
        /// whole side-channel alphabet stays plain `a-z0-9.=;`, which
        /// round-trips through `URL.absoluteString` byte-identically.
        var serializedValue: String {
            switch unit {
            case .percent: return String(raw.dropLast()) + "pct"
            case .pixels: return raw
            }
        }
    }

    public enum BlockAlignment: String, Sendable {
        case left, center, right
    }

    public enum FloatSide: String, Sendable {
        case left, right
    }

    public var width: Size?
    /// Validated with the same size rule as `width` (it is a server
    /// `recognizedKeys` member), but **parse-only on iOS for now**: neither
    /// the block nor the inline render path applies it (the sub-spec's AC
    /// requires width/align/float only; a `%` height has no meaningful
    /// reference box in SwiftUI, and applying px height without the web's
    /// CSS object-fit semantics would distort). Carried so a future phase
    /// can apply it without re-touching the parse/carry seam.
    public var height: Size?
    public var align: BlockAlignment?
    public var float: FloatSide?

    public init(width: Size? = nil, height: Size? = nil, align: BlockAlignment? = nil, float: FloatSide? = nil) {
        self.width = width
        self.height = height
        self.align = align
        self.float = float
    }

    public var isEmpty: Bool { width == nil && height == nil && align == nil && float == nil }

    /// Mirror of `parseAttrBody` (`image-attrs.ts:162-195`): whitespace-split
    /// `key=value` tokens, unknown keys/malformed tokens ignored,
    /// last-valid-wins. `interior` is the attribute block's content WITHOUT
    /// the surrounding braces (it can never contain a newline — the
    /// preprocessor's bounded regex already excludes one).
    public static func parse(attributeBlockInterior interior: String) -> ImageDisplayAttributes {
        var attrs = ImageDisplayAttributes()
        for token in interior.split(whereSeparator: { $0 == " " || $0 == "\t" }) {
            guard let equalsIndex = token.firstIndex(of: "="), equalsIndex > token.startIndex else { continue }
            attrs.apply(
                key: token[token.startIndex..<equalsIndex].lowercased(),
                value: String(token[token.index(after: equalsIndex)...])
            )
        }
        return attrs
    }

    /// The ONE application step behind `parse` (block interior) and
    /// `parseFragmentPayload` (carried fragment): route an already-split
    /// `key=value` token through the DROP rules. An invalid or empty value is
    /// a no-op — it never clears an earlier valid one (last-VALID-wins).
    private mutating func apply(key: String, value: String) {
        switch key {
        case "width":
            if let size = Size.validated(value) { width = size }
        case "height":
            if let size = Size.validated(value) { height = size }
        case "align":
            if let parsed = BlockAlignment(rawValue: value) { align = parsed }
        case "float":
            if let parsed = FloatSide(rawValue: value) { float = parsed }
        default:
            break
        }
    }
}

// MARK: - URL-fragment side-channel (the parse → provider carry seam)

extension ImageDisplayAttributes {
    /// swift-markdown-ui's `ImageProvider`/`InlineImageProvider` receive ONE
    /// piece of information per image node: its `URL`. The validated
    /// attributes therefore ride a private URL FRAGMENT the preprocessor
    /// appends (`![a](/x.png){width=60%}` →
    /// `![a](/x.png#crowi-image-attrs:width=60pct)`) and both providers
    /// detach again before anything else sees the URL.
    ///
    /// Invariant (`feature-ios-phase3` architectural pin): the DETACHED URL —
    /// what actually reaches `WorkspaceImageLoader.fetch`, the
    /// `SchemeAllowlist` check, the same-origin Bearer decision, and the
    /// disk-cache key — is **byte-identical** to what it was before this
    /// phase. Attributes never leak into the fetch/cache/origin layers; a
    /// fragment is only ever appended to a destination that had none, and
    /// `extract(from:)` removes the marker fragment in one string cut.
    ///
    /// A page author CAN hand-write this fragment directly in their image
    /// URL — that is equivalent to having written the attribute block, and
    /// harmless: `extract` re-validates every carried value through the SAME
    /// DROP rules (`parseFragmentPayload` → `Size.validated`), so a forged
    /// out-of-range value (`#crowi-image-attrs:width=99999px`) drops exactly
    /// like `{width=99999px}` would.
    public static let fragmentMarker = "crowi-image-attrs:"

    /// The fragment payload carrying every present attribute, or `nil` when
    /// there is nothing valid to carry (the preprocessor then strips the
    /// block without rewriting the destination at all).
    public var fragmentValue: String? {
        var tokens: [String] = []
        if let width { tokens.append("width=\(width.serializedValue)") }
        if let height { tokens.append("height=\(height.serializedValue)") }
        if let align { tokens.append("align=\(align.rawValue)") }
        if let float { tokens.append("float=\(float.rawValue)") }
        guard !tokens.isEmpty else { return nil }
        return Self.fragmentMarker + tokens.joined(separator: ";")
    }

    /// Decodes (and RE-VALIDATES — see `fragmentMarker`'s forged-fragment
    /// note) a carried payload. Unknown keys/invalid values drop, same as
    /// `parse` — the only difference is the token separator (`;`) and
    /// un-spelling `serializedValue`'s `pct` back to `%` before validation.
    static func parseFragmentPayload(_ payload: String) -> ImageDisplayAttributes {
        var attrs = ImageDisplayAttributes()
        for token in payload.split(separator: ";") {
            guard let equalsIndex = token.firstIndex(of: "="), equalsIndex > token.startIndex else { continue }
            let key = token[token.startIndex..<equalsIndex].lowercased()
            var value = String(token[token.index(after: equalsIndex)...])
            if key == "width" || key == "height", value.hasSuffix("pct") {
                value = String(value.dropLast(3)) + "%"
            }
            attrs.apply(key: key, value: value)
        }
        return attrs
    }

    /// Splits a possibly-carrying URL into the byte-identical pre-carry URL
    /// plus the decoded attributes. A URL without the marker (including one
    /// with an ordinary, author-written fragment) is returned untouched with
    /// `nil` attributes.
    public static func extract(from url: URL) -> (url: URL, attributes: ImageDisplayAttributes?) {
        let absolute = url.absoluteString
        guard let markerRange = absolute.range(of: "#" + fragmentMarker) else { return (url, nil) }
        let cleanedString = String(absolute[..<markerRange.lowerBound])
        let payload = String(absolute[markerRange.upperBound...])
        guard let cleanedURL = URL(string: cleanedString) else {
            // A valid URL's fragment-less prefix is itself a valid URL, so
            // this is unreachable in practice — degrade to "no attributes"
            // rather than handing downstream a URL that still carries the
            // side-channel.
            return (url, nil)
        }
        let attrs = parseFragmentPayload(payload)
        return (cleanedURL, attrs.isEmpty ? nil : attrs)
    }
}

// MARK: - Block-path application (width / align / float)

/// The pure sizing rule the block image path applies — free-standing (the
/// `WorkspaceMarkdownImageLoading` precedent) so the boundary behavior is
/// unit-testable without a SwiftUI host.
public enum ImageDisplayAttributeSizing {
    /// The width, in points, a block image with `width` should occupy inside
    /// a container `containerWidth` points wide — or `nil` for "no explicit
    /// width" (the pre-phase behavior: fill up to the container).
    ///   - `%` resolves against the container (`1...100` ⇒ never exceeds it).
    ///   - `px` composes with the block path's existing hard width cap by
    ///     taking **the smaller of the two** (the phase's architectural pin)
    ///     — a `4096px` request inside a 390pt phone column renders 390pt
    ///     wide, it does not overflow.
    public static func resolvedBlockWidth(width: ImageDisplayAttributes.Size?, containerWidth: CGFloat) -> CGFloat? {
        guard let width else { return nil }
        switch width.unit {
        case .percent:
            guard containerWidth.isFinite, containerWidth > 0 else { return nil }
            return containerWidth * CGFloat(width.number) / 100
        case .pixels:
            guard containerWidth.isFinite, containerWidth > 0 else { return CGFloat(width.number) }
            return min(CGFloat(width.number), containerWidth)
        }
    }
}

extension ImageDisplayAttributes {
    /// The horizontal placement for the block path's full-width alignment
    /// frame. `float` wins over `align` when both are present (CSS float
    /// takes the element out of normal flow, overriding block alignment);
    /// native rendering has no text-wrap equivalent for `float`, so a
    /// floated image degrades to edge alignment WITHOUT wrap — the honest
    /// native application of "place it against this edge". `nil` keeps the
    /// pre-phase default (`.center`).
    var blockFrameAlignment: SwiftUI.Alignment? {
        if let float {
            return float == .left ? .leading : .trailing
        }
        if let align {
            switch align {
            case .left: return .leading
            case .center: return .center
            case .right: return .trailing
            }
        }
        return nil
    }
}

/// A single-child `Layout` that re-proposes the width
/// `ImageDisplayAttributeSizing.resolvedBlockWidth` resolves against the
/// width THIS view was proposed (= the text column the image renders in —
/// the same reference box the web's CSS `width: 60%` resolves against),
/// passing the proposal through untouched when no width attribute applies.
struct AttributeSizedLayout: Layout {
    let width: ImageDisplayAttributes.Size?

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let subview = subviews.first else { return .zero }
        return subview.sizeThatFits(childProposal(for: proposal))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let subview = subviews.first else { return }
        subview.place(at: bounds.origin, anchor: .topLeading, proposal: childProposal(for: proposal))
    }

    private func childProposal(for proposal: ProposedViewSize) -> ProposedViewSize {
        guard
            let containerWidth = proposal.width,
            let resolved = ImageDisplayAttributeSizing.resolvedBlockWidth(width: width, containerWidth: containerWidth)
        else { return proposal }
        return ProposedViewSize(width: resolved, height: proposal.height)
    }
}

/// The block image path's ONE application point for RFC-0015 display
/// attributes: sizes its content per `AttributeSizedLayout`, then places it
/// inside the same full-container-width frame the block path has always used
/// — with `align`/`float` steering the placement, defaulting to the
/// pre-phase `.center` when absent. `WorkspaceMarkdownImageView` renders its
/// decoded image through exactly this type; with `attributes == nil` it is
/// behavior-identical to the previous bare `.frame(maxWidth: .infinity)`.
struct ImageDisplayAttributedBlockFrame<Content: View>: View {
    let attributes: ImageDisplayAttributes?
    private let content: Content

    init(attributes: ImageDisplayAttributes?, @ViewBuilder content: () -> Content) {
        self.attributes = attributes
        self.content = content()
    }

    var body: some View {
        AttributeSizedLayout(width: attributes?.width) { content }
            .frame(maxWidth: .infinity, alignment: attributes?.blockFrameAlignment ?? .center)
    }
}
