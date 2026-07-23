import SwiftUI

/// RFC-0016 §6.3 (OQ-11 resolved: banner-overlay only, no export
/// suppression in v1) — a non-scrolling, always-on-top, non-dismissible
/// notice for a confidential workspace, applied once at the workspace
/// chrome root (`RootScene`) so it covers every screen, not per-screen.
///
/// Driven by `AppInfoCache.confidential`, which is refreshed on activation /
/// foreground / a 10-minute TTL (§5.2) — NOT a frozen add-time snapshot — so
/// a workspace that becomes confidential mid-session shows this within one
/// refresh cycle, and one that stops being confidential loses it within one
/// refresh cycle too.
///
/// **Honest limit (§6.3)**: this is an in-app banner, not the web control's
/// screenshot/print guarantee — it does not reliably appear on an OS
/// screenshot of an arbitrary scroll position, nor on a share-sheet / Quick
/// Look / PDF export. `safeAreaInset` (not an `overlay` the content could
/// scroll under, and not dismissible — there is no close affordance) is
/// what "non-scrolling, always-on-top" means for a native, in-app-only
/// control in v1.
public struct ConfidentialBannerOverlay: ViewModifier {
    let notice: String?

    public func body(content: Content) -> some View {
        content.safeAreaInset(edge: .top, spacing: 0) {
            if let notice {
                ConfidentialBannerView(notice: notice)
            }
        }
    }
}

struct ConfidentialBannerView: View {
    let notice: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "lock.shield.fill")
            Text(notice)
                .font(.footnote.weight(.semibold))
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .background(Color.red.opacity(0.85))
        .foregroundStyle(.white)
        .accessibilityElement(children: .combine)
    }
}

extension View {
    /// Apply once at the workspace chrome root — never per-screen (that
    /// would risk drifting, and defeats "on every screen including chrome").
    public func confidentialBanner(_ notice: String?) -> some View {
        modifier(ConfidentialBannerOverlay(notice: notice))
    }
}
