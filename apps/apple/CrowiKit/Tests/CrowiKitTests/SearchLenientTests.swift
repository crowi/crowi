import XCTest

@testable import CrowiKit

/// RFC-0016 §5.2 CI-fixed invariant — lenient decode of `GET /search`, the
/// `search` capability gate, and the `<mark>`-stripping snippet helper
/// (§5.2's "never render raw" note — the driver's highlight tokens must
/// never reach a native `Text` unstripped).
final class SearchLenientTests: XCTestCase {
    func testDecodesHitsWithSnippetAndScore() throws {
        let json = """
        { "meta": { "total": 1, "results": 1 }, "data": [ { "pageId": "p1", "path": "/team/eng", "score": 1.5, "snippet": "<mark>eng</mark> team", "bookmarkCount": 2 } ] }
        """
        let response = try SearchPagesResponseLenient.decode(Data(json.utf8))

        XCTAssertEqual(response.total, 1)
        XCTAssertEqual(response.hits.first?.pageId, "p1")
        XCTAssertEqual(response.hits.first?.score, 1.5)
        XCTAssertEqual(response.hits.first?.bookmarkCount, 2)
    }

    func testMissingOptionalFieldsDegradeGracefully() throws {
        let json = """
        { "meta": { "total": 0, "results": 0 }, "data": [ { "pageId": "p1", "path": "/x" } ] }
        """
        let response = try SearchPagesResponseLenient.decode(Data(json.utf8))

        let hit = try XCTUnwrap(response.hits.first)
        XCTAssertNil(hit.score)
        XCTAssertNil(hit.rawSnippet)
        XCTAssertNil(hit.bookmarkCount)
    }

    func testUnknownTopLevelFieldsAreIgnored() throws {
        let json = """
        { "meta": { "total": 0, "results": 0, "took": 3 }, "data": [], "somethingNew": { "x": 1 } }
        """
        let response = try SearchPagesResponseLenient.decode(Data(json.utf8))

        XCTAssertEqual(response.hits.count, 0)
    }

    /// §5.2 — `data[].snippet` carries unescaped `<mark>` tokens the app
    /// must strip/parse itself; never render it raw.
    func testPlainSnippetStripsMarkTags() {
        XCTAssertEqual(SearchHitLenient.plainSnippet("<mark>eng</mark> team meeting"), "eng team meeting")
        XCTAssertEqual(SearchHitLenient.plainSnippet("no tags here"), "no tags here")
        XCTAssertEqual(SearchHitLenient.plainSnippet("<mark>a</mark> and <mark>b</mark>"), "a and b")
    }

    // MARK: - snippetSegments (feature-ios-visual-redesign Phase 1)

    /// The design highlights the query hit inside the snippet, and the
    /// backend really does supply the positions
    /// (`query-builder.ts`'s `pre_tags:['<mark>']`). This is the base case:
    /// the hit run comes back flagged, everything around it does not.
    func testSegmentsSplitTheDriverHighlightIntoHitAndNonHitRuns() {
        XCTAssertEqual(
            SearchHitLenient.snippetSegments("the <mark>eng</mark> team"),
            [
                .init(text: "the ", isHighlighted: false),
                .init(text: "eng", isHighlighted: true),
                .init(text: " team", isHighlighted: false),
            ]
        )
        XCTAssertEqual(
            SearchHitLenient.snippetSegments("no tags here"),
            [.init(text: "no tags here", isHighlighted: false)]
        )
        XCTAssertEqual(SearchHitLenient.snippetSegments(""), [])
    }

    /// Adjacent hits with nothing between them coalesce into ONE run, so the
    /// output has a single canonical form for a given rendered result (two
    /// runs and one run paint identically — leaving both possible would make
    /// every comparison here depend on how the driver happened to chunk it).
    func testAdjacentHighlightsCoalesceIntoOneRun() {
        XCTAssertEqual(
            SearchHitLenient.snippetSegments("<mark>a</mark><mark>b</mark>"),
            [.init(text: "ab", isHighlighted: true)]
        )
        XCTAssertEqual(
            SearchHitLenient.snippetSegments("<mark>a</mark> <mark>b</mark>"),
            [
                .init(text: "a", isHighlighted: true),
                .init(text: " ", isHighlighted: false),
                .init(text: "b", isHighlighted: true),
            ]
        )
    }

    /// The snippet is untrusted page-body text: it can carry anything that
    /// looks like a tag, in any state of brokenness. None of it may change
    /// what gets highlighted, and none of it may leave the parser stuck
    /// inside a highlight for the rest of the string.
    ///
    /// Mirrors `packages/web/src/lib/sanitise-snippet.ts`: attributes on the
    /// open tag are tolerated, a self-closing `<mark/>` opens nothing, and an
    /// orphan `</mark>` is dropped rather than underflowing the depth.
    func testHostileAndMalformedTagsCannotStickTheHighlightOn() {
        XCTAssertEqual(
            SearchHitLenient.snippetSegments("<MARK class=\"hit\">Eng</MARK> team"),
            [.init(text: "Eng", isHighlighted: true), .init(text: " team", isHighlighted: false)],
            "case and attributes are tolerated on the open tag"
        )
        XCTAssertEqual(
            SearchHitLenient.snippetSegments("<mark/>plain"),
            [.init(text: "plain", isHighlighted: false)],
            "a self-closing mark opens nothing"
        )
        XCTAssertEqual(
            SearchHitLenient.snippetSegments("</mark>plain"),
            [.init(text: "plain", isHighlighted: false)],
            "an orphan close is dropped, not allowed to underflow into a negative depth"
        )
        XCTAssertEqual(
            SearchHitLenient.snippetSegments("<mark>a<b>c</b>d</mark>e"),
            [.init(text: "acd", isHighlighted: true), .init(text: "e", isHighlighted: false)],
            "a non-mark tag inside a hit is dropped without breaking the run"
        )
        XCTAssertEqual(
            SearchHitLenient.snippetSegments("<markup>a</markup>b"),
            [.init(text: "ab", isHighlighted: false)],
            "a tag that merely STARTS with 'mark' is not a mark"
        )
        XCTAssertEqual(
            SearchHitLenient.snippetSegments("<mark>a</mark></mark>b"),
            [.init(text: "a", isHighlighted: true), .init(text: "b", isHighlighted: false)],
            "one extra close cannot make the next term un-highlightable"
        )
    }

    /// `plainSnippet` is defined as the concatenation of the segments, so a
    /// change to one can never silently diverge from the other — the
    /// highlighted row and the plain row always show the same words. Includes
    /// the pre-existing cases above plus the malformed ones, which is where a
    /// re-implementation would drift first.
    func testPlainSnippetIsExactlyTheConcatenationOfTheSegments() {
        let cases = [
            "<mark>eng</mark> team meeting",
            "no tags here",
            "<mark>a</mark> and <mark>b</mark>",
            "<MARK class=\"hit\">Eng</MARK> team",
            "<mark/>plain",
            "</mark>plain",
            "<mark>a<b>c</b>d</mark>e",
            "unterminated <mark>tail",
            "a > b",
            "",
        ]
        for raw in cases {
            XCTAssertEqual(
                SearchHitLenient.snippetSegments(raw).map(\.text).joined(),
                SearchHitLenient.plainSnippet(raw),
                "segments must reconstruct the plain snippet for \(raw.debugDescription)"
            )
        }
    }

    /// Nothing that reaches the segmenter may come back out as markup: every
    /// run is plain text with the angle brackets gone, so no downstream
    /// renderer can be handed something to interpret.
    func testNoSegmentEverCarriesMarkupThrough() {
        for segment in SearchHitLenient.snippetSegments("<script>alert(1)</script><mark>hit</mark><img src=x onerror=y>") {
            XCTAssertFalse(segment.text.contains("<"), "a run kept an opening angle bracket: \(segment.text)")
            XCTAssertFalse(segment.text.contains(">"), "a run kept a closing angle bracket: \(segment.text)")
        }
    }

    func testFetchThrowsSearchCapabilityUnavailableWhenSearchIsAbsentFromCapabilities() async {
        let client = AuthenticatedAPIClient(
            apiBaseURL: APIBaseURL(workspaceOrigin: WorkspaceOrigin(URL(string: "https://wiki.example.com")!)),
            middleware: AuthenticatingMiddleware(coordinator: makeAlwaysFreshCoordinator())
        )

        await XCTAssertThrowsErrorAsync(try await SearchPagesResponseLenient.fetch(query: "eng", capabilities: ["pages"], using: client)) { error in
            XCTAssertEqual(error as? SearchLenientDecodeError, .searchCapabilityUnavailable)
        }
    }

    private func makeAlwaysFreshCoordinator() -> RefreshCoordinator {
        let tokenStore = InMemoryTokenStore(seed: [
            "workspace-a": StoredTokenPair(accessToken: "token", refreshToken: "rt", expiresAt: Date().addingTimeInterval(3600))
        ])
        return RefreshCoordinator(workspaceId: "workspace-a", tokenStore: tokenStore, urlSession: .shared) {
            URL(string: "https://wiki.example.com/api/oauth/token")!
        }
    }
}

/// A tiny `async throws` counterpart to `XCTAssertThrowsError` — none of the
/// other test files needed this shape yet (they all drive a synchronous
/// throwing call), but `SearchPagesResponseLenient.fetch` throws from an
/// `async` context before ever reaching the network.
func XCTAssertThrowsErrorAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    file: StaticString = #filePath,
    line: UInt = #line,
    _ errorHandler: (Error) -> Void = { _ in }
) async {
    do {
        _ = try await expression()
        XCTFail("expected an error to be thrown", file: file, line: line)
    } catch {
        errorHandler(error)
    }
}
