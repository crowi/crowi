import SwiftUI

/// RFC-0023 — the VISIBLE placeholder contract (parent spec §4 /
/// wire-contract §5): `html` nodes (author or plugin — indistinguishable by
/// design), unknown/degraded nodes (`crowiOpaque`) and validation-failed
/// payloads all render as an unmistakable block chip. Silent drops are a
/// contract violation; so are crashes.
///
/// Phase 5 — `crowiPlaceholder` nodes are kind-aware: the 13 kinds group
/// into three native presentations (render-failure / size-limit /
/// generic), each with its own icon and fallback copy. A non-empty
/// server-issued `label` always wins over the group copy (the label is the
/// server's more specific story); the group still picks the ICON, so the
/// failure class stays visible either way.
enum RenderedAstPlaceholderCopy {
    /// Generic block copy (unknown / degraded content).
    static let blockUnavailable = "This content can't be displayed in the app."
    /// `html` nodes specifically — a deliberate v1 rule, not a failure.
    static let htmlBlock = "Embedded HTML isn't displayed in the app."
    /// The inline chip's short text (phrasing positions).
    static let inlineUnavailable = "unavailable content"
    /// A diagram payload the rasterizer could not decode (Phase 5).
    static let diagramFailed = "This diagram can't be displayed."
    /// `error-*` kinds — the server-side render failed.
    static let renderFailed = "This content failed to render."
    /// `size-limit-*` / `dispatch-limit` kinds — over a server limit.
    static let sizeLimited = "This content is too large to display."

    /// The three kind groups (parent spec out-of-scope pin: 13 fully
    /// individual UIs are deliberately NOT built — grouped copy +
    /// reservation-variant honoring satisfies the AC).
    enum KindGroup {
        case renderError
        case sizeLimit
        case generic

        var fallbackLabel: String {
            switch self {
            case .renderError: return RenderedAstPlaceholderCopy.renderFailed
            case .sizeLimit: return RenderedAstPlaceholderCopy.sizeLimited
            case .generic: return RenderedAstPlaceholderCopy.blockUnavailable
            }
        }

        var systemImage: String {
            switch self {
            case .renderError: return "exclamationmark.triangle"
            case .sizeLimit: return "tray.full"
            case .generic: return "eye.slash"
            }
        }
    }

    static func group(for kind: RenderedAstPlaceholderKind) -> KindGroup {
        switch kind {
        case .errorAuth, .errorRateLimit, .errorNotFound, .errorNetwork,
            .errorTimeout, .errorUnknown, .errorBlocked, .errorBusy:
            return .renderError
        case .sizeLimitEntry, .sizeLimitPage, .dispatchLimit:
            return .sizeLimit
        case .validationFailed, .envelopeInvalid:
            return .generic
        }
    }

    /// The label a `crowiPlaceholder` renders: the server's own (non-empty)
    /// `label` wins — current behavior, unchanged — with the kind group's
    /// copy as the fallback.
    static func placeholderLabel(kind: RenderedAstPlaceholderKind, serverLabel: String) -> String {
        serverLabel.isEmpty ? group(for: kind).fallbackLabel : serverLabel
    }
}

/// The block-position placeholder. The 48pt floor is `DEFAULT_RESERVATION`'s
/// (`sanitize-ast.ts`); a `crowiPlaceholder.reservation` upgrades the frame
/// per its variant — `fixed` honors the server height (above the floor),
/// `aspect` reserves an aspect-ratio box (the diagram reservation shape),
/// `card` reserves the size-tiered fixed height a card placeholder needs.
struct RenderedAstPlaceholderView: View {
    let label: String
    let systemImage: String
    let reservation: RenderedAstReservation?

    init(label: String, systemImage: String = "eye.slash", reservation: RenderedAstReservation? = nil) {
        self.label = label
        self.systemImage = systemImage
        self.reservation = reservation
    }

    /// The `crowiPlaceholder` node presentation: kind-grouped icon +
    /// server-label-first copy + reservation honoring, in one place.
    init(kind: RenderedAstPlaceholderKind, serverLabel: String, reservation: RenderedAstReservation) {
        self.init(
            label: RenderedAstPlaceholderCopy.placeholderLabel(kind: kind, serverLabel: serverLabel),
            systemImage: RenderedAstPlaceholderCopy.group(for: kind).systemImage,
            reservation: reservation
        )
    }

    /// `card` reservations reserve a fixed height per size tier (cards have
    /// no intrinsic dimensions — mirroring the web's size-tiered card CSS).
    static func cardReservationHeight(size: String) -> CGFloat {
        switch size {
        case "small": return 64
        case "large": return 160
        default: return 100
        }
    }

    /// The `fixed` variant's frame, mirroring the server's HTML-side
    /// `clampDimension` (`renderReservation`, 0...4096px) with the client's
    /// 48pt block floor: the height always reserves; a positive `widthPx`
    /// additionally reserves the width — capped at the container so a wide
    /// declaration aspect-fits into narrow columns instead of overflowing
    /// (`maxWidth == nil` means "no width declared, fill the column").
    static func fixedReservationSize(widthPx: Double?, heightPx: Double) -> (maxWidth: CGFloat?, minHeight: CGFloat) {
        let height = max(48, min(4096, CGFloat(heightPx)))
        guard let widthPx, widthPx > 0 else { return (nil, height) }
        return (min(4096, CGFloat(widthPx)), height)
    }

    var body: some View {
        reservedChip
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.05)))
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var reservedChip: some View {
        switch reservation {
        case .aspect(let aspectRatio) where aspectRatio > 0:
            framedChip(minHeight: 48)
                .aspectRatio(CGFloat(aspectRatio), contentMode: .fit)
        case .card(let size):
            framedChip(minHeight: Self.cardReservationHeight(size: size))
        case .fixed(let widthPx, let heightPx):
            let size = Self.fixedReservationSize(widthPx: widthPx, heightPx: heightPx)
            if let maxWidth = size.maxWidth {
                chip.frame(maxWidth: maxWidth, minHeight: size.minHeight, alignment: .leading)
            } else {
                framedChip(minHeight: size.minHeight)
            }
        default:
            framedChip(minHeight: 48)
        }
    }

    private func framedChip(minHeight: CGFloat) -> some View {
        chip.frame(maxWidth: .infinity, minHeight: minHeight, alignment: .leading)
    }

    private var chip: some View {
        HStack(spacing: 8) {
            Image(systemName: systemImage)
            Text(label)
                .font(.callout)
                .multilineTextAlignment(.leading)
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12)
    }
}
