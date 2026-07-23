import SwiftUI

/// RFC-0016 §5.2/§9 — the ONE search-capability-gated toolbar entry point.
///
/// Extracted out of `WorkspaceHomeView`'s toolbar closure (in
/// `apps/apple/Crowi.swiftpm`, the App target) into CrowiKit specifically so
/// this exact production UI code can be rendered/inspected directly from
/// `CrowiKitTests` (`SearchCapabilityToolbarButtonTests`) — the App target
/// itself cannot be imported there, because its package manifest depends on
/// `AppleProductTypes` (Xcode-only; the bare `swift` CLI that runs
/// `CrowiKitTests` cannot even parse it, per the Phase 0 scaffold decision).
/// `WorkspaceHomeView` places this EXACT type inside its `ToolbarItemGroup`
/// rather than re-deriving `capabilities.contains("search")` inline, so there
/// is no second, independently-maintained copy of the gate that could drift
/// from what is actually tested.
public struct SearchCapabilityToolbarButton: View {
    private let capabilities: [String]
    private let action: () -> Void

    public init(capabilities: [String], action: @escaping () -> Void) {
        self.capabilities = capabilities
        self.action = action
    }

    /// The exact condition `body` renders against — the spec's "capability
    /// gate: `search` 有→無→有 fixture で UI が追随" (§10) CI-fixed test flips
    /// this every `WorkspaceSession.capabilities` (`@Published`) refresh.
    public var isVisible: Bool { capabilities.contains("search") }

    public var body: some View {
        if isVisible {
            Button(action: action) {
                Label("Search", systemImage: "magnifyingglass")
            }
        }
    }
}
