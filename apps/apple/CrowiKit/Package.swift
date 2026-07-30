// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "CrowiKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "CrowiKit", targets: ["CrowiKit"])
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-openapi-generator", from: "1.6.0"),
        .package(url: "https://github.com/apple/swift-openapi-runtime", from: "1.7.0"),
        .package(url: "https://github.com/apple/swift-openapi-urlsession", from: "1.0.0"),
        // Gate C (RFC-0016 §5.1/§6.1) selected renderer — see the spec's
        // "Gate 判定" section for why swift-markdown-ui was picked over
        // Textual (iOS 18 floor, incompatible with RFC-0016's iOS 17 floor).
        .package(url: "https://github.com/gonzalezreal/swift-markdown-ui", from: "2.4.0"),
        // RFC-0023 Phase 5 — synchronous TeX typesetting for math/inlineMath
        // nodes (parent spec design judgment 9: native SYNC typesetting is
        // the one client-side rendering the revised SSR contract allows).
        // Pure Swift, no networking, builds on both platforms `swift test`
        // exercises.
        .package(url: "https://github.com/mgriebling/SwiftMath", from: "1.7.0"),
        // RFC-0023 Phase 5 — the crowiDiagram SVG rasterizer. A static,
        // synchronous SVG → platform-image renderer with no external
        // resource loading (pinned by RenderedAstSvgResourceLoadingTests —
        // the client half of the §8 double defense). Wrapped exclusively by
        // `RenderedAstSvgRenderer`; nothing else may import it.
        .package(url: "https://github.com/swhitty/SwiftDraw", from: "0.29.0"),
    ],
    targets: [
        .target(
            name: "CrowiKit",
            dependencies: [
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
                .product(name: "MarkdownUI", package: "swift-markdown-ui"),
                .product(name: "SwiftMath", package: "SwiftMath"),
                .product(name: "SwiftDraw", package: "SwiftDraw"),
            ],
            plugins: [
                .plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator")
            ]
        ),
        .testTarget(
            name: "CrowiKitTests",
            dependencies: ["CrowiKit"]
        )
    ]
)
