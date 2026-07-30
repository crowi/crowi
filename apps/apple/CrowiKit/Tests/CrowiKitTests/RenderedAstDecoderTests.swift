import Foundation
import SwiftUI
import XCTest

#if canImport(AppKit)
import AppKit
#endif

@testable import CrowiKit

/// RFC-0023 Phase 4 — the strict decoder's own contract, beyond what the
/// shared corpus pins:
///
///   - validation limits (tree depth 64 / hast depth 16 / input bytes 8MB /
///     `mediaType` allow-list / base64 length + canonical decode) mirror the
///     wire-contract design values EXACTLY and are enforced at decode time;
///   - node-level failure degrades ONE node to a visible placeholder,
///     envelope-level failure abandons the typed path (raw-body fallback) —
///     never a crash, never a silent drop;
///   - the response-side `astVersion` detection is independent of what the
///     request sent (old-server bare Root → fallback);
///   - `rendererVersion` influences nothing.
final class RenderedAstDecoderTests: XCTestCase {
    private func envelope(children: [[String: Any]]) -> [String: Any] {
        ["astVersion": 1, "root": ["type": "root", "children": children]]
    }

    private func decodedChildren(_ children: [[String: Any]], file: StaticString = #filePath, line: UInt = #line) -> [RenderedAstNode] {
        guard case .envelope(let document) = RenderedAstEnvelopeDecoder.decode(responseValue: envelope(children: children)) else {
            XCTFail("expected an envelope decode", file: file, line: line)
            return []
        }
        return document.children
    }

    // MARK: - shape detection (design doc §9 belt-and-suspenders)

    func testAbsentAndNullValuesReadAsMissing() {
        XCTAssertEqual(RenderedAstEnvelopeDecoder.decode(responseValue: nil), .fallbackToRawBody(.missing))
        XCTAssertEqual(RenderedAstEnvelopeDecoder.decode(responseValue: NSNull()), .fallbackToRawBody(.missing))
    }

    /// The "old API × new iOS" matrix row: the app SENT the header but the
    /// old server ignored it and returned the stored bare `Root` — typed
    /// interpretation must never be attempted.
    func testBareRootFromAnOldServerFallsBackWithoutTypedInterpretation() {
        let bareRoot: [String: Any] = [
            "type": "root",
            "children": [["type": "paragraph", "children": [["type": "text", "value": "hello"]]]],
        ]
        XCTAssertEqual(RenderedAstEnvelopeDecoder.decode(responseValue: bareRoot), .fallbackToRawBody(.noAstVersion))
    }

    func testUnsupportedFutureVersionFallsBack() {
        let value: [String: Any] = ["astVersion": 2, "root": ["type": "root", "children": [] as [Any]]]
        XCTAssertEqual(RenderedAstEnvelopeDecoder.decode(responseValue: value), .fallbackToRawBody(.unsupportedVersion(2)))
    }

    func testNonRootShapedEnvelopeRootFallsBack() {
        XCTAssertEqual(
            RenderedAstEnvelopeDecoder.decode(responseValue: ["astVersion": 1, "root": "nope"]),
            .fallbackToRawBody(.envelopeInvalid(.rootShape))
        )
        XCTAssertEqual(
            RenderedAstEnvelopeDecoder.decode(responseValue: ["astVersion": 1]),
            .fallbackToRawBody(.envelopeInvalid(.rootShape))
        )
        XCTAssertEqual(
            RenderedAstEnvelopeDecoder.decode(responseValue: ["astVersion": 1, "root": ["type": "paragraph", "children": [] as [Any]]]),
            .fallbackToRawBody(.envelopeInvalid(.rootShape))
        )
    }

    /// The server's own envelope-level collapse arrives as a NORMAL envelope
    /// with one `crowiPlaceholder{envelope-invalid}` node — no special case.
    func testServerEnvelopeInvalidPlaceholderDecodesAsANormalEnvelope() {
        let children = decodedChildren([
            [
                "type": "crowiPlaceholder",
                "kind": "envelope-invalid",
                "label": "This page could not be rendered safely and has been replaced with this placeholder.",
                "reservation": ["variant": "fixed", "heightPx": 48],
            ]
        ])
        guard case .crowiPlaceholder(let kind, _, _) = children.first?.kind else {
            return XCTFail("expected a crowiPlaceholder node")
        }
        XCTAssertEqual(kind, .envelopeInvalid)
    }

    /// `rendererVersion` is freshness diagnostics, never a render switch:
    /// its presence/absence/value changes nothing about the decode.
    func testRendererVersionNeverInfluencesTheDecode() {
        let children: [[String: Any]] = [["type": "paragraph", "children": [["type": "text", "value": "x"]]]]
        var withVersion = envelope(children: children)
        withVersion["rendererVersion"] = "99.0.0"
        XCTAssertEqual(
            RenderedAstEnvelopeDecoder.decode(responseValue: withVersion),
            RenderedAstEnvelopeDecoder.decode(responseValue: envelope(children: children))
        )
    }

    // MARK: - envelope-level limits (§7 — iterative pre-pass, raw-body fallback)

    private func nestedBlockquotes(totalDepth: Int) -> [String: Any] {
        // root is depth 1; each blockquote adds one level.
        var node: [String: Any] = ["type": "paragraph", "children": [["type": "text", "value": "x"]]]
        // paragraph + text occupy the two innermost levels.
        for _ in 0..<(totalDepth - 3) {
            node = ["type": "blockquote", "children": [node]]
        }
        return ["astVersion": 1, "root": ["type": "root", "children": [node]]]
    }

    func testTreeDepthLimitIsSixtyFour() {
        guard case .envelope = RenderedAstEnvelopeDecoder.decode(responseValue: nestedBlockquotes(totalDepth: RenderedAstWireContract.maxTreeDepth)) else {
            return XCTFail("a depth-64 tree must decode")
        }
        XCTAssertEqual(
            RenderedAstEnvelopeDecoder.decode(responseValue: nestedBlockquotes(totalDepth: RenderedAstWireContract.maxTreeDepth + 1)),
            .fallbackToRawBody(.envelopeInvalid(.treeDepthExceeded))
        )
    }

    private func textWithHastDepth(_ depth: Int) -> [String: Any] {
        var child: [String: Any] = ["type": "text", "value": "🎉"]
        for _ in 0..<(depth - 1) {
            child = ["type": "element", "tagName": "span", "children": [child]]
        }
        return [
            "astVersion": 1,
            "root": [
                "type": "root",
                "children": [
                    [
                        "type": "paragraph",
                        "children": [
                            ["type": "text", "value": "🎉", "data": ["hName": "span", "hChildren": [child]]]
                        ],
                    ]
                ],
            ],
        ]
    }

    func testHastSubtreeDepthLimitIsSixteen() {
        guard case .envelope = RenderedAstEnvelopeDecoder.decode(responseValue: textWithHastDepth(RenderedAstWireContract.maxHastDepth)) else {
            return XCTFail("a hast depth-16 subtree must decode")
        }
        XCTAssertEqual(
            RenderedAstEnvelopeDecoder.decode(responseValue: textWithHastDepth(RenderedAstWireContract.maxHastDepth + 1)),
            .fallbackToRawBody(.envelopeInvalid(.hastDepthExceeded))
        )
    }

    func testInputByteLimitIsEightMegabytes() {
        // 45 × 200,000-char text nodes ≈ 9MB serialized — over the 8MB gate.
        let bigValue = String(repeating: "a", count: RenderedAstWireContract.maxValueChars)
        let children: [[String: Any]] = (0..<45).map { _ in
            ["type": "paragraph", "children": [["type": "text", "value": bigValue]]]
        }
        XCTAssertEqual(
            RenderedAstEnvelopeDecoder.decode(responseValue: envelope(children: children)),
            .fallbackToRawBody(.envelopeInvalid(.inputBytesExceeded))
        )
    }

    // MARK: - node-level degrades (visible placeholders, never a lost page)

    func testUnknownNodeTypeBecomesAVisibleOpaqueNodeAndItsSubtreeIsNotRecursed() {
        let children = decodedChildren([
            ["type": "x-plugin-callout", "children": [["type": "text", "value": "inner"]]],
            ["type": "paragraph", "children": [["type": "text", "value": "still here"]]],
        ])
        XCTAssertEqual(children.count, 2, "the rest of the page must survive")
        guard case .crowiOpaque(let reason, let originalType) = children[0].kind else {
            return XCTFail("expected crowiOpaque, got \(children[0].kind)")
        }
        XCTAssertEqual(reason, .unknownType)
        XCTAssertEqual(originalType, "x-plugin-callout")
        XCTAssertTrue(children[0].children.isEmpty, "an unknown node's children have no known content model")
        XCTAssertEqual(children[1].kind, .paragraph)
    }

    func testOverlongUnknownTypeIsTruncatedTo64Characters() {
        let longType = String(repeating: "y", count: 100)
        let children = decodedChildren([["type": longType]])
        guard case .crowiOpaque(_, let originalType) = children[0].kind else {
            return XCTFail("expected crowiOpaque")
        }
        XCTAssertEqual(originalType?.count, 64)
    }

    func testBlockNodeInPhrasingPositionBecomesInvalidPositionOpaque() {
        let children = decodedChildren([
            [
                "type": "paragraph",
                "children": [
                    ["type": "blockquote", "children": [] as [Any]],
                    ["type": "text", "value": "tail"],
                ],
            ]
        ])
        guard case .crowiOpaque(let reason, let originalType) = children[0].children[0].kind else {
            return XCTFail("expected crowiOpaque")
        }
        XCTAssertEqual(reason, .invalidPosition)
        XCTAssertEqual(originalType, "blockquote")
        XCTAssertEqual(children[0].children[1].kind, .text(value: "tail"))
    }

    func testKnownTypeWithBrokenShapeBecomesInvalidShapeOpaque() {
        let children = decodedChildren([["type": "heading", "children": [] as [Any]]]) // no depth
        guard case .crowiOpaque(let reason, let originalType) = children[0].kind else {
            return XCTFail("expected crowiOpaque")
        }
        XCTAssertEqual(reason, .invalidShape)
        XCTAssertEqual(originalType, "heading")
    }

    func testHtmlNodeSurvivesDecodeAsHtml() {
        let children = decodedChildren([["type": "html", "value": "<div>anything</div>"]])
        XCTAssertEqual(children[0].kind, .html(value: "<div>anything</div>"))
    }

    // MARK: - §10 deep image validation (mediaType / base64 / dimensions)

    private func diagram(mediaType: String, base64: String, width: Int = 100, height: Int = 50) -> [String: Any] {
        [
            "type": "crowiDiagram",
            "kind": "mermaid",
            "alt": "diagram",
            "image": ["mediaType": mediaType, "base64": base64, "width": width, "height": height],
        ]
    }

    func testDisallowedMediaTypeDegradesToAVisiblePlaceholder() {
        let children = decodedChildren([diagram(mediaType: "image/gif", base64: "AAAA")])
        guard case .crowiOpaque(let reason, _) = children[0].kind else {
            return XCTFail("expected a visible degrade node, got \(children[0].kind)")
        }
        XCTAssertEqual(reason, .invalidShape)
    }

    func testOverlongBase64DegradesToAVisiblePlaceholder() {
        let overlong = String(repeating: "A", count: RenderedAstWireContract.maxImageBase64Chars + 4)
        let children = decodedChildren([diagram(mediaType: "image/svg+xml", base64: overlong)])
        guard case .crowiOpaque(let reason, _) = children[0].kind else {
            return XCTFail("expected a visible degrade node, got \(children[0].kind)")
        }
        XCTAssertEqual(reason, .invalidShape)
    }

    func testNonCanonicalBase64DegradesToAValidationFailedPlaceholder() {
        let children = decodedChildren([diagram(mediaType: "image/svg+xml", base64: "not base64!")])
        guard case .crowiPlaceholder(let kind, _, _) = children[0].kind else {
            return XCTFail("expected crowiPlaceholder, got \(children[0].kind)")
        }
        XCTAssertEqual(kind, .validationFailed)
    }

    func testDecodedImageOverSizeCapDegradesToAValidationFailedPlaceholder() {
        // 140,000 canonical base64 chars decode to 105,000 bytes — over the
        // 100KB decoded cap while within the char cap.
        let big = String(repeating: "A", count: RenderedAstWireContract.maxImageBase64Chars)
        let children = decodedChildren([diagram(mediaType: "image/svg+xml", base64: big)])
        guard case .crowiPlaceholder(let kind, _, _) = children[0].kind else {
            return XCTFail("expected crowiPlaceholder, got \(children[0].kind)")
        }
        XCTAssertEqual(kind, .validationFailed)
    }

    func testPngPayloadWithoutPngSignatureDegrades() {
        let children = decodedChildren([diagram(mediaType: "image/png", base64: "AAAAAAAAAAAA")])
        guard case .crowiPlaceholder(let kind, _, _) = children[0].kind else {
            return XCTFail("expected crowiPlaceholder, got \(children[0].kind)")
        }
        XCTAssertEqual(kind, .validationFailed)
    }

    func testPngPayloadWithSignatureDecodes() {
        let pngHeader = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D])
        let children = decodedChildren([diagram(mediaType: "image/png", base64: pngHeader.base64EncodedString())])
        guard case .crowiDiagram(let kind, _, _, let image) = children[0].kind else {
            return XCTFail("expected crowiDiagram, got \(children[0].kind)")
        }
        XCTAssertEqual(kind, .mermaid)
        XCTAssertEqual(image.width, 100)
    }

    func testDimensionsOutsideTheClosedIntervalDegrade() {
        let zero = decodedChildren([diagram(mediaType: "image/svg+xml", base64: "AAAA", width: 0)])
        guard case .crowiOpaque = zero[0].kind else { return XCTFail("width 0 must degrade") }
        let over = decodedChildren([diagram(mediaType: "image/svg+xml", base64: "AAAA", height: RenderedAstWireContract.maxDimension + 1)])
        guard case .crowiOpaque = over[0].kind else { return XCTFail("height 16385 must degrade") }
        let max = decodedChildren([diagram(mediaType: "image/svg+xml", base64: "AAAA", width: RenderedAstWireContract.maxDimension)])
        guard case .crowiDiagram = max[0].kind else { return XCTFail("the closed-interval max must be valid") }
    }

    // MARK: - §8 URL rules at decode time

    func testJavascriptLinkUrlDegradesToHashAndKeepsTheNode() {
        let children = decodedChildren([
            [
                "type": "paragraph",
                "children": [
                    ["type": "link", "url": "javascript:alert(1)", "children": [["type": "text", "value": "x"]]]
                ],
            ]
        ])
        XCTAssertEqual(children[0].children[0].kind, .link(url: "#", title: nil))
        XCTAssertEqual(children[0].children[0].children.first?.kind, .text(value: "x"))
    }

    func testMailtoLinkUrlPassesTheWireRuleButStaysInertAtTapTime() {
        let children = decodedChildren([
            [
                "type": "paragraph",
                "children": [
                    ["type": "link", "url": "mailto:a@example.com", "children": [["type": "text", "value": "mail"]]]
                ],
            ]
        ])
        // Wire rule (§8 general): mailto survives decode…
        XCTAssertEqual(children[0].children[0].kind, .link(url: "mailto:a@example.com", title: nil))
        // …and §6.2 (OQ-9 pin) inerts it at the tap boundary.
        XCTAssertFalse(SchemeAllowlist.isAllowed("mailto:a@example.com"))
    }

    func testJavascriptImageUrlBecomesAVisiblePlaceholder() {
        let children = decodedChildren([
            ["type": "paragraph", "children": [["type": "image", "url": "javascript:alert(1)"]]]
        ])
        guard case .crowiPlaceholder(let kind, _, _) = children[0].children[0].kind else {
            return XCTFail("expected crowiPlaceholder, got \(children[0].children[0].kind)")
        }
        XCTAssertEqual(kind, .validationFailed)
    }

    func testLinkCardUrlIsHttpOnlyAndItsImageDropsIndependently() {
        // mailto card URL → whole card degrades (the §8 card override is
        // STRICTER than the general rule).
        let mailtoCard = decodedChildren([["type": "crowiLinkCard", "url": "mailto:a@example.com"]])
        guard case .crowiPlaceholder = mailtoCard[0].kind else {
            return XCTFail("a non-http(s) card URL must degrade the card")
        }
        // Relative card IMAGE → drop the image, keep the card.
        let relativeImage = decodedChildren([
            ["type": "crowiLinkCard", "url": "https://example.com/a", "image": ["url": "/relative.png"]]
        ])
        guard case .crowiLinkCard(let payload) = relativeImage[0].kind else {
            return XCTFail("the card itself must survive an invalid card image")
        }
        XCTAssertEqual(payload.url, "https://example.com/a")
        XCTAssertNil(payload.imageURL, "the invalid image must be dropped, not kept")
    }

    func testProtocolRelativeUrlIsRejectedByTheGeneralRule() {
        XCTAssertFalse(RenderedAstEnvelopeDecoder.isAllowedGeneralURL("//evil.example.com/x"))
        XCTAssertTrue(RenderedAstEnvelopeDecoder.isAllowedGeneralURL("/wiki/setup"))
        XCTAssertTrue(RenderedAstEnvelopeDecoder.isAllowedGeneralURL("#anchor"))
        XCTAssertTrue(RenderedAstEnvelopeDecoder.isAllowedGeneralURL("https://example.com"))
        XCTAssertFalse(RenderedAstEnvelopeDecoder.isAllowedGeneralURL("data:text/html,x"))
    }

    // MARK: - inline semantics (link classification / emoji a11y / broken wikilinks)

    func testLinkClassificationFollowsTheServerClassNameStamps() {
        XCTAssertEqual(
            RenderedAstInlineRenderer.classifyLink(url: "/user/alice", classNames: ["mention"]),
            .mention(username: "alice")
        )
        XCTAssertEqual(
            RenderedAstInlineRenderer.classifyLink(url: "#", classNames: ["wikilink-broken"]),
            .brokenWikiLink
        )
        XCTAssertEqual(
            RenderedAstInlineRenderer.classifyLink(url: "/wiki/setup", classNames: []),
            .standard(url: "/wiki/setup")
        )
    }

    func testMentionLinksCarryTheSharedPseudoSchemeSoOneInterceptorServesBothPaths() throws {
        let mention = RenderedAstNode(
            kind: .link(url: "/user/alice", title: nil),
            data: RenderedAstNodeData(hProperties: ["className": .string("mention")]),
            children: [RenderedAstNode(kind: .text(value: "@alice"))]
        )
        let result = RenderedAstInlineRenderer().render([mention])
        let run = result.attributed.runs.first { $0.link != nil }
        let url = try XCTUnwrap(run?.link)
        XCTAssertEqual(WikiLinkMentionPreprocessor.classify(url), .mentionUsername("alice"))
    }

    func testBrokenWikilinksRenderVisiblyBrokenAndInert() {
        let broken = RenderedAstNode(
            kind: .link(url: "#", title: nil),
            data: RenderedAstNodeData(hProperties: ["className": .string("wikilink-broken")]),
            children: [RenderedAstNode(kind: .text(value: "not-absolute"))]
        )
        let result = RenderedAstInlineRenderer().render([broken])
        for run in result.attributed.runs {
            XCTAssertNil(run.link, "a broken wikilink must never be navigable")
        }
        let styled = result.attributed.runs.contains { $0.underlineStyle != nil }
        XCTAssertTrue(styled, "a broken wikilink must be visually distinct, not a plain text run")
    }

    func testEmojiAriaLabelBecomesTheAccessibilityLabel() {
        let nodes: [RenderedAstNode] = [
            RenderedAstNode(kind: .text(value: "done ")),
            RenderedAstNode(
                kind: .text(value: "🎉"),
                data: RenderedAstNodeData(
                    hName: "span",
                    hProperties: ["role": .string("img"), "ariaLabel": .string("tada emoji")],
                    hChildren: [.text(value: "🎉")]
                )
            ),
        ]
        let result = RenderedAstInlineRenderer().render(nodes)
        XCTAssertEqual(result.accessibilityLabel, "done tada emoji")
        XCTAssertTrue(String(result.attributed.characters).contains("🎉"), "the emoji glyph itself must still render")
    }

    func testPlainTextHasNoAccessibilityOverride() {
        let result = RenderedAstInlineRenderer().render([RenderedAstNode(kind: .text(value: "plain"))])
        XCTAssertNil(result.accessibilityLabel)
    }

    func testCjkFragmentAndPathLinksStillProduceTappableURLs() throws {
        let fragment = try XCTUnwrap(RenderedAstInlineRenderer.linkURL(for: "#日本語の見出し"))
        XCTAssertNil(fragment.scheme)
        XCTAssertTrue(fragment.relativeString.hasPrefix("#"))
        let path = try XCTUnwrap(RenderedAstInlineRenderer.linkURL(for: "/日本語ページ"))
        XCTAssertNil(path.scheme)
        XCTAssertEqual(path.relativeString.removingPercentEncoding, "/日本語ページ")
    }

    // MARK: - crowiFigure attribute re-validation (drop, never clamp)

    func testFigureAttributesAreRevalidatedPerValueAndOutOfRangeDrops() {
        let figureData = RenderedAstNodeData(
            hName: "figure",
            hProperties: ["className": .string("crowi-figure"), "data-crowi-image-align": .string("center")]
        )
        let imageData = RenderedAstNodeData(
            hProperties: ["data-crowi-image-width": .string("150%"), "data-crowi-image-height": .string("300px")]
        )
        let attributes = RenderedAstFigureView.displayAttributes(figureData: figureData, imageData: imageData)
        XCTAssertNil(attributes?.width, "150% is outside 1..100 — DROPPED, never clamped to 100%")
        XCTAssertEqual(attributes?.height?.raw, "300px")
        XCTAssertEqual(attributes?.align, .center)
    }

    func testFigureWithOnlyInvalidAttributesYieldsNoAttributes() {
        let imageData = RenderedAstNodeData(hProperties: ["data-crowi-image-width": .string("99999px")])
        XCTAssertNil(RenderedAstFigureView.displayAttributes(figureData: nil, imageData: imageData))
    }

    // MARK: - visible-placeholder rendering (never a crash, never a silent drop)

    /// Renders the degrade surface through real SwiftUI (the
    /// `PageRowTitleLabelTests` `ImageRenderer` seam): html, unknown-opaque
    /// and validation placeholders must all occupy visible space. (`math`
    /// left this surface in Phase 5 — it typesets natively now.)
    @MainActor
    func testHtmlUnknownAndPlaceholderNodesRenderVisibly() throws {
        let document = RenderedAstDocument(children: [
            RenderedAstNode(kind: .html(value: "<script>x</script>")),
            RenderedAstNode(kind: .crowiOpaque(reason: .unknownType, originalType: "x-plugin-callout")),
            RenderedAstNode(kind: .crowiPlaceholder(
                kind: .validationFailed,
                label: RenderedAstEnvelopeDecoder.validationFailedLabel,
                reservation: .fixed(widthPx: nil, heightPx: 48)
            )),
        ])
        let view = RenderedAstView(
            document: document,
            imageLoader: StubImageFetcher(),
            imageBaseURL: URL(string: "https://wiki.example.com")!,
            onNavigateToWikiLink: { _ in },
            onNavigateToMention: { _ in },
            onNavigateToRelativePath: { _ in }
        )
        let size = try renderedSize(view, width: 390)
        // 3 degraded blocks at ≥48pt each — far taller than one empty row.
        XCTAssertGreaterThanOrEqual(size.height, 3 * 48, "every degraded node must occupy visible space")
    }

    /// The core-node happy path renders through real SwiftUI too — the
    /// objective "does not crash, produces layout" gate for the walker→view
    /// pipeline (task list, table, code tokens, blockquote, figure).
    @MainActor
    func testCoreNodesRenderWithoutCrashing() throws {
        let heading = RenderedAstNode(
            kind: .heading(depth: 2),
            data: RenderedAstNodeData(hProperties: ["id": .string("getting-started")]),
            children: [RenderedAstNode(kind: .text(value: "Getting Started"))]
        )
        let paragraph = RenderedAstNode(kind: .paragraph, children: [
            RenderedAstNode(kind: .text(value: "hello ")),
            RenderedAstNode(kind: .strong, children: [RenderedAstNode(kind: .text(value: "bold"))]),
            RenderedAstNode(kind: .lineBreak),
            RenderedAstNode(kind: .inlineCode(value: "let x = 1")),
        ])
        let list = RenderedAstNode(kind: .list(ordered: false, start: nil, spread: false), children: [
            RenderedAstNode(kind: .listItem(checked: true, spread: false), children: [
                RenderedAstNode(kind: .paragraph, children: [RenderedAstNode(kind: .text(value: "done"))])
            ]),
            RenderedAstNode(kind: .listItem(checked: nil, spread: false), children: [
                RenderedAstNode(kind: .paragraph, children: [RenderedAstNode(kind: .text(value: "plain"))])
            ]),
        ])
        let code = RenderedAstNode(
            kind: .code(value: "const x = 1;", lang: "ts", meta: nil),
            data: RenderedAstNodeData(tokens: [[
                RenderedAstShikiToken(
                    content: "const x = 1;",
                    light: RenderedAstShikiTokenStyle(color: "#0550AE", fontStyle: [.bold]),
                    dark: RenderedAstShikiTokenStyle(color: "#79C0FF")
                )
            ]])
        )
        let table = RenderedAstNode(kind: .table(align: [.left, nil]), children: [
            RenderedAstNode(kind: .tableRow, children: [
                RenderedAstNode(kind: .tableCell, children: [RenderedAstNode(kind: .text(value: "h1"))]),
                RenderedAstNode(kind: .tableCell, children: [RenderedAstNode(kind: .text(value: "h2"))]),
            ]),
            RenderedAstNode(kind: .tableRow, children: [
                RenderedAstNode(kind: .tableCell, children: [RenderedAstNode(kind: .text(value: "a"))]),
                RenderedAstNode(kind: .tableCell, children: [RenderedAstNode(kind: .text(value: "b"))]),
            ]),
        ])
        let quote = RenderedAstNode(kind: .blockquote, children: [
            RenderedAstNode(kind: .paragraph, children: [RenderedAstNode(kind: .text(value: "quoted"))])
        ])
        let document = RenderedAstDocument(children: [heading, paragraph, list, code, table, quote, RenderedAstNode(kind: .thematicBreak)])
        let view = RenderedAstView(
            document: document,
            imageLoader: StubImageFetcher(),
            imageBaseURL: URL(string: "https://wiki.example.com")!,
            onNavigateToWikiLink: { _ in },
            onNavigateToMention: { _ in },
            onNavigateToRelativePath: { _ in }
        )
        let size = try renderedSize(view, width: 390)
        XCTAssertGreaterThan(size.height, 100, "the core-node document must produce real layout")
    }

    // MARK: - Phase 5 projection mirror (§5 step 1b / §6 hoist), beyond the corpus pins

    /// Walks a STORED bare `Root` (the server walker's input) through the
    /// local mirror and returns the projected children.
    private func mirroredChildren(_ children: [[String: Any]], file: StaticString = #filePath, line: UInt = #line) -> [RenderedAstNode] {
        guard case .document(let document) = RenderedAstEnvelopeDecoder.sanitize(["type": "root", "children": children]) else {
            XCTFail("expected the stored AST to walk", file: file, line: line)
            return []
        }
        return document.children
    }

    private func htmlNode(sidecars: [String: Any], value: String = "<div>generated</div>") -> [String: Any] {
        ["type": "html", "value": value, "data": sidecars]
    }

    func testCrowiCodeSidecarProjectsToATokenizedCodeNode() {
        let children = mirroredChildren([
            htmlNode(sidecars: [
                "crowiCode": [
                    "lang": "ts",
                    "value": "const x = 1;",
                    "tokens": [[["content": "const x = 1;", "light": ["color": "#0550AE"], "dark": ["color": "#79C0FF"]]]],
                ]
            ])
        ])
        guard case .code(let value, let lang, _) = children.first?.kind else {
            return XCTFail("expected a projected code node, got \(String(describing: children.first?.kind))")
        }
        XCTAssertEqual(value, "const x = 1;")
        XCTAssertEqual(lang, "ts")
        XCTAssertEqual(children.first?.data?.tokens?.first?.first?.content, "const x = 1;")
    }

    /// Exactly ONE sidecar key projects — two is ambiguous and stays html
    /// (§5 step 1b's "fail safe towards html").
    func testTwoSidecarKeysStayHtml() {
        let children = mirroredChildren([
            htmlNode(sidecars: [
                "crowiMath": ["tex": "x", "display": true],
                "crowiPlaceholder": ["kind": "error-unknown", "label": "x", "reservation": ["variant": "fixed", "heightPx": 48]],
            ])
        ])
        guard case .html = children.first?.kind else {
            return XCTFail("an ambiguous multi-sidecar html node must stay html")
        }
        XCTAssertNil(children.first?.data, "the sidecar keys must not survive into v1 data")
    }

    /// `display` picks the node type AND constrains the position: display
    /// math cannot live in phrasing position (and vice versa) — the html
    /// node stays rather than projecting somewhere illegal.
    func testDisplayMathInPhrasingPositionStaysHtml() {
        let children = mirroredChildren([
            [
                "type": "paragraph",
                "children": [htmlNode(sidecars: ["crowiMath": ["tex": "E", "display": true]])],
            ]
        ])
        guard case .html = children.first?.children.first?.kind else {
            return XCTFail("display math must not project into phrasing position")
        }
    }

    /// The §6 hoist chain: a card in a paragraph (through phrasing
    /// ancestors) hoists to block position, splitting the ancestor chain;
    /// empty halves are never emitted.
    func testLinkCardHoistSplitsThroughPhrasingAncestors() {
        let card = htmlNode(sidecars: ["crowiLinkCard": ["url": "https://example.com/a"]])
        let children = mirroredChildren([
            [
                "type": "paragraph",
                "children": [
                    ["type": "emphasis", "children": [
                        ["type": "text", "value": "before"],
                        card,
                        ["type": "text", "value": "after"],
                    ]]
                ],
            ]
        ])
        XCTAssertEqual(children.count, 3, "expected [paragraph(em(before)), card, paragraph(em(after))]")
        guard case .paragraph = children[0].kind, case .emphasis = children[0].children.first?.kind,
            case .crowiLinkCard = children[1].kind,
            case .paragraph = children[2].kind
        else {
            return XCTFail("the ancestor chain must re-wrap around the hoisted card: \(children.map(\.kind))")
        }
    }

    func testMultipleCardsInOneParagraphAllHoist() {
        let cardA = htmlNode(sidecars: ["crowiLinkCard": ["url": "https://example.com/a"]])
        let cardB = htmlNode(sidecars: ["crowiLinkCard": ["url": "https://example.com/b"]])
        let children = mirroredChildren([
            ["type": "paragraph", "children": [cardA, ["type": "text", "value": "mid"], cardB]]
        ])
        XCTAssertEqual(children.count, 3, "expected [cardA, paragraph(mid), cardB] — no empty paragraphs")
        guard case .crowiLinkCard(let a) = children[0].kind, case .paragraph = children[1].kind,
            case .crowiLinkCard(let b) = children[2].kind
        else {
            return XCTFail("both cards must hoist: \(children.map(\.kind))")
        }
        XCTAssertEqual(a.url, "https://example.com/a")
        XCTAssertEqual(b.url, "https://example.com/b")
    }

    /// chain=false positions (`heading` / `tableCell`) cannot hoist — the
    /// card sidecar does NOT project and the html node stays (a visible
    /// placeholder on this client, the deliberate §6 asymmetry).
    func testLinkCardInAHeadingStaysHtml() {
        let card = htmlNode(sidecars: ["crowiLinkCard": ["url": "https://example.com/a"]])
        let children = mirroredChildren([
            ["type": "heading", "depth": 2, "children": [card]]
        ])
        guard case .html = children.first?.children.first?.kind else {
            return XCTFail("a card in a heading must stay html (no hoist chain)")
        }
    }

    /// The §10 deep validation applies to PROJECTED nodes too: a
    /// schema-valid diagram sidecar with undecodable base64 degrades to the
    /// visible validation-failed placeholder (not html, not a crash).
    func testProjectedDiagramWithBadBase64BecomesAVisiblePlaceholder() {
        let children = mirroredChildren([
            htmlNode(sidecars: [
                "crowiDiagram": [
                    "kind": "mermaid",
                    "alt": "broken",
                    "image": ["mediaType": "image/svg+xml", "base64": "!!not-base64!!", "width": 20, "height": 10],
                ]
            ])
        ])
        guard case .crowiPlaceholder(let kind, _, _) = children.first?.kind else {
            return XCTFail("a deep-validation failure must become a visible placeholder")
        }
        XCTAssertEqual(kind, .validationFailed)
    }

    /// The §8 card override applies at projection time too: a non-http(s)
    /// sidecar image URL drops (image-less card), a non-http(s) card URL
    /// degrades the whole card.
    func testProjectedCardUrlsAreHttpOnly() {
        let badImage = mirroredChildren([
            htmlNode(sidecars: [
                "crowiLinkCard": ["url": "https://example.com/a", "image": ["url": "javascript:alert(1)"]]
            ])
        ])
        guard case .crowiLinkCard(let payload) = badImage.first?.kind else {
            return XCTFail("the card must survive a bad image URL")
        }
        XCTAssertNil(payload.imageURL)

        let badUrl = mirroredChildren([
            htmlNode(sidecars: ["crowiLinkCard": ["url": "mailto:a@example.com"]])
        ])
        guard case .crowiPlaceholder(let kind, _, _) = badUrl.first?.kind else {
            return XCTFail("a non-http(s) card URL must degrade the projected card")
        }
        XCTAssertEqual(kind, .validationFailed)
    }

    /// `data.hProperties` carries over to the projected node (load-bearing
    /// for preview scroll-sync on display math, §10).
    func testProjectionCarriesHProperties() {
        let children = mirroredChildren([
            [
                "type": "html",
                "value": "<span>…katex…</span>",
                "data": [
                    "crowiMath": ["tex": "E = mc^2", "display": true],
                    "hProperties": ["data-source-line": 12],
                ] as [String: Any],
            ]
        ])
        guard case .math(let value, _) = children.first?.kind else {
            return XCTFail("expected a projected math node")
        }
        XCTAssertEqual(value, "E = mc^2")
        XCTAssertEqual(children.first?.data?.hProperties["data-source-line"], .number(12))
    }

    private struct StubImageFetcher: WorkspaceImageFetching {
        func fetch(_ urlString: String) async throws -> Data { Data() }
    }

    @MainActor
    private func renderedSize(_ view: some View, width: CGFloat) throws -> CGSize {
        #if canImport(AppKit)
        let renderer = ImageRenderer(content: view.frame(width: width))
        renderer.scale = 1
        guard let nsImage = renderer.nsImage else { throw RenderingUnavailable() }
        return nsImage.size
        #else
        throw RenderingUnavailable()
        #endif
    }
}

private struct RenderingUnavailable: Error {}
