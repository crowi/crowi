import SwiftUI

/// RFC-0023 Phase 4 — the VISIBLE placeholder contract (parent spec §4 /
/// wire-contract §5): `html` nodes (author or plugin — indistinguishable by
/// design), unknown/degraded nodes (`crowiOpaque`), validation-failed
/// payloads and the not-yet-native typed extension nodes (math / diagrams /
/// link cards — Phase 5 promotes those) all render as an unmistakable block
/// chip. Silent drops are a contract violation; so are crashes.
enum RenderedAstPlaceholderCopy {
    /// Generic block copy (unknown / degraded / not-yet-native content).
    static let blockUnavailable = "This content can't be displayed in the app."
    /// `html` nodes specifically — a deliberate v1 rule, not a failure.
    static let htmlBlock = "Embedded HTML isn't displayed in the app."
    /// The inline chip's short text (phrasing positions).
    static let inlineUnavailable = "unavailable content"
}

/// The block-position placeholder. `heightHint` honors a
/// `crowiPlaceholder.reservation`'s fixed height when one arrived; the
/// 48pt floor is `DEFAULT_RESERVATION`'s (`sanitize-ast.ts`).
struct RenderedAstPlaceholderView: View {
    let label: String
    var heightHint: CGFloat?

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "eye.slash")
            Text(label)
                .font(.callout)
                .multilineTextAlignment(.leading)
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, minHeight: max(48, heightHint ?? 48), alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.05)))
        .accessibilityElement(children: .combine)
    }
}
