// swift-tools-version:5.10
import PackageDescription
import AppleProductTypes

// RFC-0016 §10 — apps/apple is a package.json-less tooling island: this
// manifest (using `AppleProductTypes`, which is only understood by Xcode's
// bundled SwiftPM, not the open-source `swift` CLI) is the App target and is
// what `xcodebuild build -scheme Crowi -destination 'generic/platform=iOS
// Simulator'` builds. This directory MUST be named `Crowi.swiftpm` (the
// `.swiftpm` extension is not decorative) — Xcode only permits a
// `.iOSApplication` product inside a folder with that extension; without it,
// opening this manifest fails with "iOS app products are only permitted in
// Swift Playground packages" (verified empirically: the plain `xcodebuild
// -scheme` CLI invocation does not hit this check, but Xcode's own project
// loader does, so it only surfaces when opening the package interactively).
// The shared client/auth/rendering logic that `swift test` exercises lives
// in the plain, Xcode-independent local package one level up at
// ../CrowiKit (see ../CrowiKit/Package.swift) — split out specifically
// because a manifest that `import AppleProductTypes` cannot be parsed by the
// bare `swift` CLI at all (verified empirically during Phase 0: `swift
// build` fails with "no such module 'AppleProductTypes'"), so `swift test`
// MUST run with CrowiKit as its working directory, never this one.
let package = Package(
    name: "Crowi",
    platforms: [.iOS(.v17)],
    products: [
        .iOSApplication(
            name: "Crowi",
            targets: ["CrowiApp"],
            bundleIdentifier: "wiki.crowi.ios",
            teamIdentifier: "ABCDE12345",
            displayVersion: "0.1",
            bundleVersion: "1",
            iconAssetName: nil,
            accentColorAssetName: nil,
            supportedDeviceFamilies: [
                .phone,
                .pad
            ],
            supportedInterfaceOrientations: [
                .portrait,
                .landscapeRight,
                .landscapeLeft
            ],
            additionalInfoPlistContentFilePath: "Support/AdditionalInfo.plist"
        )
    ],
    dependencies: [
        .package(path: "../CrowiKit")
    ],
    targets: [
        .executableTarget(
            name: "CrowiApp",
            dependencies: [
                .product(name: "CrowiKit", package: "CrowiKit")
            ]
        )
    ]
)
