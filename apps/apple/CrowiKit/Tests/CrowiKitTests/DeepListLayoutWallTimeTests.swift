import SwiftUI
import XCTest

@testable import CrowiKit

/// Wall-time REGRESSION GUARD for the deep-nested-list main-thread wedge.
///
/// Opening a page whose body has 8-level-deep nested bullet lists used to
/// wedge the main thread forever: the recursive per-level
/// `HStack(marker, RenderedAstBlockSequence)` nesting made SwiftUI's
/// StackLayout sizing explode ~×15 per nesting level (measured on the real
/// payload's shape: depth 3 → 140ms, 4 → 906ms, 5 → 15.0s, 6+ → >25s).
/// `RenderedAstListView` therefore renders lists FLAT
/// (`RenderedAstListFlattener` — a pre-order row walk with depth-indexed
/// indentation, never per-level stack recursion).
///
/// This test forces a full first layout of a depth-8 list document through
/// the same headless-`ImageRenderer` technique the diagnosis probe used. The
/// bound is deliberately generous (it should complete in milliseconds): if
/// it ever trips — or the test wedges outright — list rendering has regressed
/// back into per-level layout recursion. Do NOT raise the bound; fix the
/// nesting.
final class DeepListLayoutWallTimeTests: XCTestCase {
    private struct StubImageFetcher: WorkspaceImageFetching {
        func fetch(_ urlString: String) async throws -> Data { Data() }
    }

    /// The real failing page's shape, depth-parametrized: a bullet list, two
    /// items per level, each carrying wrapping Japanese text and (below the
    /// max depth) a nested sub-list. Depth 8 yields 510 items — a strict
    /// superset of the real payload (89 items across 8 nesting levels).
    static func deepListNode(level: Int, maxDepth: Int) -> RenderedAstNode {
        var items: [RenderedAstNode] = []
        for index in 0..<2 {
            var children: [RenderedAstNode] = [
                RenderedAstNode(
                    kind: .paragraph,
                    children: [
                        RenderedAstNode(kind: .text(
                            value: "項目\(level)-\(index) これは折り返しが発生する程度の長さの日本語テキストで実ページの形を再現する"
                        ))
                    ]
                )
            ]
            if level + 1 < maxDepth {
                children.append(deepListNode(level: level + 1, maxDepth: maxDepth))
            }
            items.append(RenderedAstNode(kind: .listItem(checked: nil, spread: nil), children: children))
        }
        return RenderedAstNode(kind: .list(ordered: false, start: nil, spread: nil), children: items)
    }

    @MainActor
    private func firstLayoutSeconds(of view: some View) throws -> TimeInterval {
        let started = Date()
        let renderer = ImageRenderer(content: AnyView(view).frame(width: 390).padding())
        renderer.proposedSize = ProposedViewSize(width: 390, height: nil)
        #if canImport(AppKit)
        let image = renderer.nsImage
        #else
        let image = renderer.uiImage
        #endif
        let elapsed = Date().timeIntervalSince(started)
        XCTAssertNotNil(image, "headless first layout must produce an image")
        return elapsed
    }

    /// The AST (primary) page-body path: a depth-8 nested list document must
    /// complete its first layout in bounded wall time.
    @MainActor
    func testAstPathDepth8NestedListFirstLayoutCompletesInBoundedWallTime() throws {
        let document = RenderedAstDocument(children: [Self.deepListNode(level: 0, maxDepth: 8)])
        let view = RenderedAstView(
            document: document,
            imageLoader: StubImageFetcher(),
            imageBaseURL: URL(string: "https://example.com")!,
            onNavigateToWikiLink: { _ in },
            onNavigateToMention: { _ in },
            onNavigateToRelativePath: { _ in }
        )
        let elapsed = try firstLayoutSeconds(of: view)
        XCTAssertLessThan(
            elapsed, 5.0,
            "depth-8 list first layout took \(elapsed)s — list rendering has regressed into per-level layout recursion"
        )
    }

    /// The raw-body / cache-paint path (`WorkspacePageMarkdownView` →
    /// MarkdownUI): a depth-8 markdown bullet body must complete first
    /// layout in bounded wall time. This is the path
    /// `NestedListDepthClampPreprocessor` guards — MarkdownUI still lays
    /// nested lists out recursively, so without the depth-4 clamp this body
    /// wedges exactly like the AST path used to.
    @MainActor
    func testRawBodyPathDepth8NestedListFirstLayoutCompletesInBoundedWallTime() throws {
        // Depth 8, two items per level (one leaf + one recursing) — deep
        // enough to wedge un-clamped, small enough (16 lines) to render
        // quickly once clamped to depth 4.
        var lines: [String] = []
        for level in 0..<8 {
            let indent = String(repeating: "  ", count: level)
            lines.append("\(indent)- 項目\(level)-a これは折り返しが発生する程度の長さの日本語テキストで実ページの形を再現する")
            lines.append("\(indent)- 項目\(level)-b これは折り返しが発生する程度の長さの日本語テキストで実ページの形を再現する")
        }
        let view = WorkspacePageMarkdownView(
            rawBody: lines.joined(separator: "\n"),
            imageLoader: StubImageFetcher(),
            imageBaseURL: URL(string: "https://example.com")!,
            onNavigateToWikiLink: { _ in },
            onNavigateToMention: { _ in },
            onNavigateToRelativePath: { _ in }
        )
        let elapsed = try firstLayoutSeconds(of: view)
        XCTAssertLessThan(
            elapsed, 10.0,
            "depth-8 raw-body first layout took \(elapsed)s — the MarkdownUI nesting clamp has regressed"
        )
    }
}
