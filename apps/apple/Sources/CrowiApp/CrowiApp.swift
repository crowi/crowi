import CrowiKit
import SwiftUI

/// RFC-0016 — Phase 0 scaffold. The real multi-workspace shell (§3) lands in
/// Phase 1 (feature-ios-phase1-workspace-auth); this entry point exists so
/// the app target links `CrowiKit` and builds/runs on the iOS Simulator,
/// proving the App ⇄ CrowiKit dependency wiring end to end.
@main
struct CrowiApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

struct ContentView: View {
    var body: some View {
        VStack(spacing: 12) {
            Text("Crowi")
                .font(.largeTitle)
            Text("Phase 0 scaffold — CrowiKit v\(CrowiKitInfo.version)")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding()
    }
}
