import XCTest

@testable import CrowiKit

/// feature-ios-visual-redesign Phase 3 — the page reader's table of contents.
///
/// Pure rules only: the extractor takes a decoded document and returns rows,
/// so every one of its decisions (which nodes count, what the label says,
/// which rows can be jumped to, how nesting is normalized) is asserted here
/// without any layout at all.
final class RenderedAstTableOfContentsTests: XCTestCase {
    // MARK: - Builders

    private func heading(_ depth: Int, _ text: String, id: String? = nil) -> RenderedAstNode {
        RenderedAstNode(
            kind: .heading(depth: depth),
            data: id.map { RenderedAstNodeData(hProperties: ["id": .string($0)]) },
            children: [RenderedAstNode(kind: .text(value: text))]
        )
    }

    private func paragraph(_ text: String) -> RenderedAstNode {
        RenderedAstNode(kind: .paragraph, children: [RenderedAstNode(kind: .text(value: text))])
    }

    // MARK: - Levels and nesting

    /// The outline: every heading in document order, each carrying its own
    /// wire depth and an indentation step normalized against the SHALLOWEST
    /// heading on the page.
    func testHeadingsAreReturnedInDocumentOrderWithNormalizedIndentation() {
        let document = RenderedAstDocument(children: [
            heading(1, "Overview", id: "overview"),
            paragraph("body"),
            heading(2, "Setup", id: "setup"),
            heading(3, "Secrets", id: "secrets"),
            heading(2, "Steps", id: "steps"),
        ])

        let toc = RenderedAstTableOfContents.headings(in: document)

        XCTAssertEqual(toc.map(\.title), ["Overview", "Setup", "Secrets", "Steps"])
        XCTAssertEqual(toc.map(\.level), [1, 2, 3, 2])
        XCTAssertEqual(toc.map(\.indentLevel), [0, 1, 2, 1])
        XCTAssertEqual(toc.map(\.id), [0, 1, 2, 3], "identity is the pre-order position, so duplicate titles stay distinct")
    }

    /// A page whose headings start at `##` (by far the most common shape —
    /// the title is the page name, not an `h1`) reads FLUSH LEFT. Indenting
    /// the whole outline by one step because no `h1` happens to exist is the
    /// bug this normalization exists to prevent.
    func testTheShallowestHeadingOnThePageIsAlwaysTheFlushLeftOne() {
        let document = RenderedAstDocument(children: [
            heading(2, "First", id: "a"),
            heading(3, "Second", id: "b"),
        ])

        XCTAssertEqual(RenderedAstTableOfContents.headings(in: document).map(\.indentLevel), [0, 1])
    }

    /// A jump from `h1` straight to `h6` must not indent six steps off the
    /// edge of the sheet — the outline is a jump list, not a tree view.
    func testIndentationIsCappedSoADeepJumpStaysOnScreen() {
        let document = RenderedAstDocument(children: [
            heading(1, "Top", id: "top"),
            heading(6, "Very deep", id: "deep"),
        ])

        let toc = RenderedAstTableOfContents.headings(in: document)
        XCTAssertEqual(toc.map(\.indentLevel), [0, RenderedAstTableOfContents.maximumIndentLevel])
        XCTAssertEqual(toc.map(\.level), [1, 6], "the real depth is still reported, only the indentation is clamped")
    }

    /// Headings nested inside a blockquote or a list item are still RENDERED
    /// by `RenderedAstBlockView` — with their anchors — so leaving them out
    /// would hide a destination the reader can actually reach.
    func testHeadingsNestedInsideOtherBlocksAreFound() {
        let document = RenderedAstDocument(children: [
            heading(1, "Top", id: "top"),
            RenderedAstNode(kind: .blockquote, children: [heading(2, "Quoted", id: "quoted")]),
            RenderedAstNode(
                kind: .list(ordered: false, start: nil, spread: nil),
                children: [
                    RenderedAstNode(
                        kind: .listItem(checked: nil, spread: nil),
                        children: [heading(3, "In a list", id: "in-a-list")]
                    )
                ]
            ),
        ])

        XCTAssertEqual(
            RenderedAstTableOfContents.headings(in: document).map(\.title),
            ["Top", "Quoted", "In a list"],
            "document order is preserved across the nesting"
        )
    }

    // MARK: - Anchors: server-issued or nothing

    /// The anchor is the server's `data.hProperties.id` — the exact value
    /// `RenderedAstBlockView.headingView` registers through
    /// `RenderedAstView.anchorID`. It is NEVER derived from the title: a
    /// client-side slugger would produce ids the body does not have, and the
    /// tap would scroll nowhere while looking like it worked.
    func testTheAnchorIsTheServerIssuedIdAndNeverASlugOfTheTitle() {
        let document = RenderedAstDocument(children: [
            heading(1, "Overview", id: "custom-server-id"),
            heading(2, "No id at all"),
        ])

        let toc = RenderedAstTableOfContents.headings(in: document)

        XCTAssertEqual(toc[0].anchor, "custom-server-id")
        XCTAssertTrue(toc[0].isNavigable)
        XCTAssertEqual(
            toc[0].anchor.map(RenderedAstView.anchorID),
            RenderedAstView.anchorID("custom-server-id"),
            "the row jumps to the same scroll id the renderer registered"
        )

        XCTAssertNil(toc[1].anchor, "a heading the server gave no id is not jumpable…")
        XCTAssertFalse(toc[1].isNavigable)
        XCTAssertEqual(toc[1].title, "No id at all", "…but it still shows, so the outline has no holes")
    }

    /// An EMPTY id reads as no id: the renderer would register
    /// `anchorID("")`, which nothing can name and which would make the row a
    /// dead tap that looks live.
    func testAnEmptyIdIsTreatedAsNoAnchor() {
        let document = RenderedAstDocument(children: [heading(1, "Empty id", id: "")])

        let toc = RenderedAstTableOfContents.headings(in: document)
        XCTAssertEqual(toc.count, 1)
        XCTAssertNil(toc[0].anchor)
    }

    /// A non-string `id` (the wire allows numbers and arrays in
    /// `hProperties`) is not an anchor either — `hPropertyString` is the same
    /// accessor the renderer reads, so the two agree by construction.
    func testANonStringIdIsNotAnAnchor() {
        let node = RenderedAstNode(
            kind: .heading(depth: 1),
            data: RenderedAstNodeData(hProperties: ["id": .number(42)]),
            children: [RenderedAstNode(kind: .text(value: "Numeric id"))]
        )

        let toc = RenderedAstTableOfContents.headings(in: RenderedAstDocument(children: [node]))
        XCTAssertEqual(toc.count, 1)
        XCTAssertNil(toc[0].anchor)
    }

    // MARK: - Labels

    /// A heading's label is its phrasing content flattened: inline code,
    /// emphasis and links contribute their text, a hard break becomes a
    /// space, and every whitespace run collapses — a TOC row is one line.
    func testTheLabelFlattensPhrasingContentToASingleLine() {
        let node = RenderedAstNode(
            kind: .heading(depth: 2),
            data: RenderedAstNodeData(hProperties: ["id": .string("mixed")]),
            children: [
                RenderedAstNode(kind: .text(value: "Deploy  ")),
                RenderedAstNode(kind: .inlineCode(value: "wrangler deploy")),
                RenderedAstNode(kind: .lineBreak),
                RenderedAstNode(kind: .strong, children: [RenderedAstNode(kind: .text(value: "\nto production\n"))]),
            ]
        )

        let toc = RenderedAstTableOfContents.headings(in: RenderedAstDocument(children: [node]))
        XCTAssertEqual(toc.map(\.title), ["Deploy wrangler deploy to production"])
    }

    /// A heading with no text at all — an image-only heading whose image has
    /// no alt — would render as a blank row that says nothing and, tapped,
    /// jumps somewhere unnamed. Dropped rather than shown.
    func testAHeadingWithNoTextAtAllIsDropped() {
        let untitled = RenderedAstNode(
            kind: .heading(depth: 1),
            data: RenderedAstNodeData(hProperties: ["id": .string("untitled")]),
            children: [RenderedAstNode(kind: .image(url: "/x.png", alt: nil, title: nil))]
        )
        let titled = heading(1, "Real", id: "real")

        let toc = RenderedAstTableOfContents.headings(in: RenderedAstDocument(children: [untitled, titled]))
        XCTAssertEqual(toc.map(\.title), ["Real"])
        XCTAssertEqual(toc.map(\.id), [0], "identity is re-assigned over the rows that survived, so `ForEach` stays unique")
    }

    /// An image WITH an alt is the alt (the same text the body would read out
    /// for it), so a heading is not silently dropped for containing one.
    func testAnImageContributesItsAltText() {
        let node = RenderedAstNode(
            kind: .heading(depth: 1),
            data: RenderedAstNodeData(hProperties: ["id": .string("logo")]),
            children: [RenderedAstNode(kind: .image(url: "/logo.png", alt: "Crowi", title: nil))]
        )

        XCTAssertEqual(RenderedAstTableOfContents.headings(in: RenderedAstDocument(children: [node])).map(\.title), ["Crowi"])
    }

    // MARK: - Documents with no table of contents

    func testADocumentWithNoHeadingsHasNoTableOfContents() {
        let document = RenderedAstDocument(children: [paragraph("just prose"), paragraph("and more")])
        XCTAssertTrue(RenderedAstTableOfContents.headings(in: document).isEmpty)
    }

    func testAnEmptyDocumentHasNoTableOfContents() {
        XCTAssertTrue(RenderedAstTableOfContents.headings(in: RenderedAstDocument(children: [])).isEmpty)
    }

    /// The raw-body fallback path has no AST at all, so it has no anchors —
    /// EVERY non-envelope outcome (and a missing one) yields nothing, which
    /// is what makes the reader's Contents control absent rather than
    /// present-and-empty there.
    func testEveryPathWithoutADecodedEnvelopeYieldsNothing() {
        let outcomes: [RenderedAstDecodeOutcome?] = [
            nil,
            .fallbackToRawBody(.missing),
            .fallbackToRawBody(.noAstVersion),
            .fallbackToRawBody(.unsupportedVersion(2)),
            .fallbackToRawBody(.envelopeInvalid(.treeDepthExceeded)),
        ]

        for outcome in outcomes {
            XCTAssertTrue(
                RenderedAstTableOfContents.headings(in: outcome).isEmpty,
                "\(String(describing: outcome)) must not produce a table of contents"
            )
        }

        XCTAssertEqual(
            RenderedAstTableOfContents.headings(in: .envelope(RenderedAstDocument(children: [heading(1, "Yes", id: "yes")]))).map(\.title),
            ["Yes"],
            "…while a decoded envelope does"
        )
    }
}
