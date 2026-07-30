import Foundation
import SwiftUI

/// RFC-0023 Phase 5 — native rendering for `crowiLinkCard` nodes from the
/// structured OGP fields (`url` + optional `title`/`description`/`image`/
/// `siteName`/`domain`).
///
/// Contract pins (parent spec §10 / wire-contract §10):
///
///   - **A url-only card is a NORMAL card**, not a degraded state: fetch
///     failure and the admin toggle-off produce the same url-only sidecar
///     by design (deliberately indistinguishable), so this view renders it
///     first-class — the URL takes the title slot.
///   - **The OGP image is an external URL** and must NEVER go through
///     `WorkspaceImageLoader` (its same-origin Bearer would leak the token
///     to a third-party host). It loads through a plain shared `URLSession`
///     with no auth decoration, gated by the ONE `SchemeAllowlist`.
///   - **Fixed image slot**: the thumbnail area has a constant size from
///     the moment the card lays out (OGP carries no dimensions — the
///     client-side reservation policy, parent spec design judgment 3), and
///     it stays reserved through EVERY load state — loading → success →
///     failure never shifts layout. A failed image renders the image-less
///     presentation (nothing visible in the slot, no chrome) while keeping
///     the reservation, so the card's height and text wrapping are
///     identical before and after the request finishes. A DISALLOWED image
///     URL never reserves the slot in the first place (no before/after to
///     diverge).
///   - **Tap is the standard link path**: the card is a plain `Link`, so
///     the tap routes through `RenderedAstView`'s `openURL` interceptor and
///     its `SchemeAllowlist` gate like every other link (the decoder
///     already enforced http(s)-only on `url` — §8's card override).
struct RenderedAstLinkCardView: View {
    let payload: RenderedAstLinkCardPayload

    /// The fixed thumbnail slot, in points — reserved whenever a loadable
    /// image URL exists, constant across every load state.
    static let imageSlotSize = CGSize(width: 76, height: 76)

    @State private var slotImage: RenderedAstLinkCardImageState = .loading

    var body: some View {
        if let destination = URL(string: payload.url) {
            Link(destination: destination) { card }
                .buttonStyle(.plain)
        } else {
            // A URL that fails Foundation parsing cannot be a destination —
            // still show the card content (visibly, inert) rather than
            // dropping the node.
            card
        }
    }

    private var card: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(Self.displayTitle(for: payload))
                    .font(.subheadline.bold())
                    .foregroundStyle(Color.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                if let description = payload.description, !description.isEmpty {
                    Text(description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                if let footer = Self.footerText(for: payload) {
                    Text(footer)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let imageURL = Self.slotImageURL(for: payload) {
                imageSlot(url: imageURL)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.04)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.primary.opacity(0.08)))
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func imageSlot(url: URL) -> some View {
        Group {
            switch slotImage.slotPresentation {
            case .image(let image):
                Image(platformImage: image)
                    .resizable()
                    .scaledToFill()
            case .pendingChrome:
                Color.primary.opacity(0.05)
            case .empty:
                // Failed load: the image-less presentation — nothing
                // visible, but the frame below still reserves the slot so
                // the card's geometry cannot change after the request.
                Color.clear
            }
        }
        .frame(width: Self.imageSlotSize.width, height: Self.imageSlotSize.height)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .task { await loadSlotImage(url: url) }
    }

    private func loadSlotImage(url: URL) async {
        guard case .loading = slotImage else { return }
        slotImage = await RenderedAstLinkCardImageLoading.load(url: url)
    }

    // MARK: - pure display rules (unit-tested without a SwiftUI host)

    /// A url-only card puts the URL in the title slot (the same visual the
    /// web's fallback card renders — a first-class card, not an error).
    static func displayTitle(for payload: RenderedAstLinkCardPayload) -> String {
        if let title = payload.title, !title.isEmpty { return title }
        return payload.url
    }

    /// `siteName · domain` (either alone when the other is absent).
    static func footerText(for payload: RenderedAstLinkCardPayload) -> String? {
        let parts = [payload.siteName, payload.domain].compactMap { $0 }.filter { !$0.isEmpty }
        guard !parts.isEmpty else { return nil }
        return parts.joined(separator: " · ")
    }

    /// The thumbnail URL, or `nil` when there is none or its scheme fails
    /// the shared `SchemeAllowlist` (belt and suspenders — the decoder
    /// already dropped non-http(s) card images; a SECOND allowlist
    /// implementation is exactly what the architecture notes forbid, so
    /// this defers to the one shared gate).
    static func slotImageURL(for payload: RenderedAstLinkCardPayload) -> URL? {
        guard let raw = payload.imageURL, let url = URL(string: raw) else { return nil }
        // The card contract is stricter than the general allowlist: an
        // external OGP image must be an ABSOLUTE http(s) URL (a relative
        // reference has no workspace to rebase against here).
        guard url.scheme != nil, SchemeAllowlist.isAllowed(url) else { return nil }
        return url
    }
}

enum RenderedAstLinkCardImageState {
    case loading
    case loaded(PlatformImage)
    case failed

    /// What the fixed slot renders in each load state. The slot's FRAME is
    /// reserved unconditionally whenever a loadable image URL exists — no
    /// state removes it (the fixed-slot contract: a card must have the same
    /// height before and after the request finishes). Failure only empties
    /// the slot's content.
    var slotPresentation: RenderedAstLinkCardSlotPresentation {
        switch self {
        case .loading: return .pendingChrome
        case .loaded(let image): return .image(image)
        case .failed: return .empty
        }
    }
}

/// The content of the (always-reserved) fixed image slot.
enum RenderedAstLinkCardSlotPresentation: Equatable {
    /// Subtle placeholder fill while the request is in flight.
    case pendingChrome
    /// The loaded thumbnail.
    case image(PlatformImage)
    /// Failed load: the image-less card — the slot renders nothing visible
    /// but keeps its reservation so layout never shifts.
    case empty
}

/// Free-standing (the `WorkspaceMarkdownImageLoading` precedent) so the
/// fetch/decode rule is testable. Uses an UNAUTHENTICATED shared session on
/// purpose — see the Bearer-leak note on `RenderedAstLinkCardView`.
enum RenderedAstLinkCardImageLoading {
    static func load(url: URL, session: URLSession = .shared) async -> RenderedAstLinkCardImageState {
        guard let (data, response) = try? await session.data(from: url) else { return .failed }
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) { return .failed }
        guard let image = PlatformImage(data: data) else { return .failed }
        return .loaded(image)
    }
}
