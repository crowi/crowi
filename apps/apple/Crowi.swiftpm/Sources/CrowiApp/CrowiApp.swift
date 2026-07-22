import CrowiKit
import SwiftUI

/// RFC-0016 Phase 1 (feature-ios-phase1-workspace-auth) — the real
/// multi-workspace shell (§3): a single `WorkspaceStore` owns the ordered
/// workspace list + `activeWorkspaceId`, injected into the environment so
/// every screen below `RootScene` reads/writes through the same store.
@main
struct CrowiApp: App {
    @StateObject private var workspaceStore = WorkspaceStore()

    var body: some Scene {
        WindowGroup {
            RootScene()
                .environmentObject(workspaceStore)
        }
    }
}
