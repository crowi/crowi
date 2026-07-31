import SwiftUI

/// feature-ios-visual-redesign Phase 1 — the design's search field:
/// `background:var(--muted)`, `border-radius:12px`, `padding:9px 12px`,
/// `gap:8px`, 16px input text, a leading magnifier and a trailing clear
/// button that only exists while there is something to clear.
///
/// Replaces `.searchable(text:)` on the search screen. `.searchable` renders
/// the system search bar, which cannot be given this fill/radius/placement
/// (the design puts the field in the scrolling content, under the screen
/// title, not in the navigation bar) — and the two cannot coexist without
/// showing the user two search fields.
public struct CrowiSearchField: View {
    @Binding private var text: String
    private let prompt: String
    private let onSubmit: () -> Void

    public init(text: Binding<String>, prompt: String, onSubmit: @escaping () -> Void) {
        _text = text
        self.prompt = prompt
        self.onSubmit = onSubmit
    }

    /// Whether the trailing clear button is shown.
    ///
    /// The gate is the RAW text being non-empty, deliberately NOT the design's
    /// `hasQuery` (which is `query.trim()`): `hasQuery` also gates the results
    /// list, where trimming is right, but reusing it here would leave a field
    /// containing only spaces with no way to empty it except backspacing
    /// blindly — and it is the one state where a user most wants the button.
    /// This also matches what every system text field does.
    public static func showsClearButton(for text: String) -> Bool {
        !text.isEmpty
    }

    /// Whether the field holds a query worth *searching for* — the design's
    /// `hasQuery`, i.e. trimmed. Whitespace alone is not a query, so this is
    /// what gates the results section (and what stops a stray space from
    /// firing a request that can only return nothing).
    public static func hasEffectiveQuery(_ text: String) -> Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public var body: some View {
        HStack(spacing: CrowiMetrics.searchFieldContentSpacing) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(CrowiTheme.mutedForeground)
                .accessibilityHidden(true)
            TextField(prompt, text: $text)
                .textFieldStyle(.plain)
                .font(CrowiTypography.searchInput)
                .foregroundStyle(CrowiTheme.foreground)
                .submitLabel(.search)
                .autocorrectionDisabled()
                #if os(iOS)
                    .textInputAutocapitalization(.never)
                #endif
                .onSubmit(onSubmit)
            if Self.showsClearButton(for: text) {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(CrowiTheme.border)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, CrowiMetrics.searchFieldHorizontalPadding)
        .padding(.vertical, CrowiMetrics.searchFieldVerticalPadding)
        .frame(minHeight: CrowiMetrics.minimumTapTarget)
        .background(
            CrowiTheme.muted,
            in: RoundedRectangle(cornerRadius: CrowiTheme.controlCornerRadius, style: .continuous)
        )
        .padding(.horizontal, CrowiMetrics.cardHorizontalMargin)
    }
}
