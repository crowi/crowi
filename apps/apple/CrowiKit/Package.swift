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
    ],
    targets: [
        .target(
            name: "CrowiKit",
            dependencies: [
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
                .product(name: "MarkdownUI", package: "swift-markdown-ui"),
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
