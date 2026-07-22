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
    @StateObject private var gateASpike = GateASpikeRunner()

    var body: some View {
        VStack(spacing: 12) {
            Text("Crowi")
                .font(.largeTitle)
            Text("Phase 0 scaffold — CrowiKit v\(CrowiKitInfo.version)")
                .font(.footnote)
                .foregroundStyle(.secondary)

            Divider()

            // Throwaway gate A spike (feature-ios-phase0-gates.md) — proves
            // the ASWAS end-to-end flow now that feature-ios-companion-server
            // has landed. Deleted once the Gate 判定 section records the result.
            Button("Gate A: sign in (spike)") {
                gateASpike.run()
            }
            Text(gateASpike.status)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
        }
        .padding()
    }
}
