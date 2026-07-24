import Foundation

/// RFC-0016 §8 / `feature-ios-phase2-write` — the grant-picker domain type
/// mirroring `PageGrantEnum` (`packages/api-contract/src/schemas/page.ts`:
/// 1 public / 2 restricted / 3 specified / 4 owner). Being a closed `enum`
/// whose raw values ARE the server's valid grant numbers, the picker
/// structurally cannot emit an invalid grant — the spec's "client 側 picker
/// で構造的に防ぐ(有効値のみ emit)" pin — and the server-side
/// `INVALID_GRANT` branch becomes a defensive fallback only
/// (`PageCreateFlow` retries once with the default grant if it is ever
/// received anyway).
///
/// SPECIFIED (3) is deliberately absent (task openQuestion, resolved here):
/// `CreatePageRequestSchema` carries no `grantedUsers` parameter, so sending
/// `3` alone would create a specified-users page with nobody specifiable —
/// v1 offers the three grants that are self-contained.
public enum PageGrantOption: Int, CaseIterable, Sendable, Identifiable {
    case publicPage = 1
    case restricted = 2
    case ownerOnly = 4

    public var id: Int { rawValue }

    /// English UI label, matching the App target's existing all-English copy.
    public var displayName: String {
        switch self {
        case .publicPage: return "Public"
        case .restricted: return "Restricted"
        case .ownerOnly: return "Owner only"
        }
    }
}
