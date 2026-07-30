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
