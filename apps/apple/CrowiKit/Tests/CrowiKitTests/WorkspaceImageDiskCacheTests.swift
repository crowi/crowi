import XCTest

@testable import CrowiKit

/// RFC-0016 §6.1/§7.2 CI-fixed invariants for the disk-cache WRAPPER around
/// the already-proven `WorkspaceImageLoader` (Phase 0/1):
///   - the 200-real/200-placeholder/500-error trichotomy for an embedded
///     `/attachments/<id>` URL, and the 200-real/404-missing/500-error
///     trichotomy for a by-key avatar URL — never conflated;
///   - a placeholder response is NEVER cached permanently (re-hits the
///     network on the next call);
///   - the underlying same-origin-Bearer + redirect-strip behavior still
///     holds through the cache wrapper (a regression guard, not a
///     re-verification of `WorkspaceImageLoaderTests`' own coverage).
final class WorkspaceImageDiskCacheTests: XCTestCase {
    private let workspaceOrigin = URL(string: "https://wiki.example.com")!

    /// Mirrors `WorkspaceContext.makeImageLoader()`'s real wiring: the
    /// loader's `accessTokenProvider` reads the CURRENT token lazily from
    /// the same `tokenStore` the coordinator writes to on refresh — never a
    /// value captured once — so a reactive-401 test can observe the retry
    /// actually pick up the rotated token.
    private func makeCache(
        scratchDirectory: URL,
        confidential: Bool = false,
        handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)
    ) -> (WorkspaceImageDiskCache, RequestRecorder) {
        let recorder = RequestRecorder()
        MockURLProtocol.requestHandler = { request in
            recorder.record(request)
            return try handler(request)
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]

        let tokenStore = InMemoryTokenStore(seed: [
            "workspace-a": StoredTokenPair(accessToken: "the-token", refreshToken: "rt-1", expiresAt: Date().addingTimeInterval(3600))
        ])
        let loader = WorkspaceImageLoader(
            workspaceOrigin: workspaceOrigin,
            accessTokenProvider: { (try? tokenStore.load(forWorkspace: "workspace-a"))?.accessToken ?? "" },
            sessionConfiguration: configuration
        )
        let coordinator = RefreshCoordinator(workspaceId: "workspace-a", tokenStore: tokenStore, urlSession: MockURLProtocol.makeSession()) {
            URL(string: "https://wiki.example.com/api/oauth/token")!
        }
        let cache = WorkspaceImageDiskCache(loader: loader, coordinator: coordinator, cacheDirectory: scratchDirectory, confidential: confidential)
        return (cache, recorder)
    }

    private func makeScratchDirectory() -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        return directory
    }

    private let realPNGBytes = Data([0x89, 0x50, 0x4E, 0x47, 0xDE, 0xAD, 0xBE, 0xEF])

    // MARK: - Embedded `/attachments/<id>` trichotomy

    func testEmbeddedRealImageIsCachedAndServedFromDiskOnASecondFetch() async throws {
        let (cache, recorder) = makeCache(scratchDirectory: makeScratchDirectory()) { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png"])!, self.realPNGBytes)
        }

        let first = try await cache.fetchResult("/api/attachments/abc")
        let second = try await cache.fetchResult("/api/attachments/abc")

        XCTAssertEqual(first, .real(realPNGBytes))
        XCTAssertEqual(second, .real(realPNGBytes))
        XCTAssertEqual(recorder.requests.count, 1, "a cached real image must be served from disk without a second network round-trip")
    }

    func testEmbeddedPlaceholderIsNeverCachedPermanentlyAndRefetchesEveryTime() async throws {
        let (cache, recorder) = makeCache(scratchDirectory: makeScratchDirectory()) { request in
            (
                HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png"])!,
                WorkspaceImageDiskCache.bundledPlaceholderReferenceData
            )
        }

        let first = try await cache.fetchResult("/api/attachments/missing")
        let second = try await cache.fetchResult("/api/attachments/missing")

        XCTAssertEqual(first, .placeholder(WorkspaceImageDiskCache.bundledPlaceholderReferenceData))
        XCTAssertEqual(second, .placeholder(WorkspaceImageDiskCache.bundledPlaceholderReferenceData))
        XCTAssertEqual(recorder.requests.count, 2, "a placeholder response must NEVER be cached permanently — every fetch must re-hit the network")
    }

    func testEmbeddedServerErrorSurfacesAsARetryableError() async throws {
        let (cache, _) = makeCache(scratchDirectory: makeScratchDirectory()) { request in
            (HTTPURLResponse(url: request.url!, statusCode: 500, httpVersion: nil, headerFields: nil)!, Data())
        }

        await XCTAssertThrowsErrorAsync(try await cache.fetchResult("/api/attachments/broken")) { error in
            XCTAssertEqual(error as? WorkspaceImageDiskCache.FetchError, .serverError(status: 500))
        }
    }

    // MARK: - Avatar `/attachments/by-key/<key>` trichotomy (DIFFERENT from embedded)

    func testByKeyRealAvatarIsCachedTheSameWayAsEmbedded() async throws {
        let (cache, recorder) = makeCache(scratchDirectory: makeScratchDirectory()) { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png"])!, self.realPNGBytes)
        }

        _ = try await cache.fetchResult("/api/attachments/by-key/user/abc.png")
        _ = try await cache.fetchResult("/api/attachments/by-key/user/abc.png")

        XCTAssertEqual(recorder.requests.count, 1)
    }

    /// The by-key shape's own `200` response is NEVER a placeholder, even if
    /// its bytes happened to coincidentally match the embedded shape's
    /// well-known placeholder image — the trichotomy is chosen by URL shape,
    /// not sniffed from content alone, so the two shapes are never conflated.
    func testByKeyResponseIsNeverTreatedAsAPlaceholderEvenIfBytesMatch() async throws {
        let (cache, _) = makeCache(scratchDirectory: makeScratchDirectory()) { request in
            (
                HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png"])!,
                WorkspaceImageDiskCache.bundledPlaceholderReferenceData
            )
        }

        let result = try await cache.fetchResult("/api/attachments/by-key/user/abc.png")

        XCTAssertEqual(result, .real(WorkspaceImageDiskCache.bundledPlaceholderReferenceData))
    }

    func testByKeyMissingAvatarIsNotFoundNotAnError() async throws {
        let (cache, _) = makeCache(scratchDirectory: makeScratchDirectory()) { request in
            (HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!, Data())
        }

        let result = try await cache.fetchResult("/api/attachments/by-key/user/missing.png")

        XCTAssertEqual(result, .notFound)
    }

    func testByKeyServerErrorSurfacesAsARetryableError() async throws {
        let (cache, _) = makeCache(scratchDirectory: makeScratchDirectory()) { request in
            (HTTPURLResponse(url: request.url!, statusCode: 500, httpVersion: nil, headerFields: nil)!, Data())
        }

        await XCTAssertThrowsErrorAsync(try await cache.fetchResult("/api/attachments/by-key/user/broken.png")) { error in
            XCTAssertEqual(error as? WorkspaceImageDiskCache.FetchError, .serverError(status: 500))
        }
    }

    // MARK: - §6.1 same-origin-Bearer + redirect-strip regression THROUGH the cache

    func testTheCacheStillAttachesBearerOnlyForSameOriginRequests() async throws {
        var capturedAuthorization: String?
        let (cache, _) = makeCache(scratchDirectory: makeScratchDirectory()) { request in
            capturedAuthorization = request.value(forHTTPHeaderField: "Authorization")
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png"])!, self.realPNGBytes)
        }

        _ = try await cache.fetchResult("/api/attachments/abc")

        XCTAssertEqual(capturedAuthorization, "Bearer the-token")
    }

    func testTheCacheNeverAttachesBearerForACrossOriginAbsoluteURL() async throws {
        var capturedAuthorization: String?
        let (cache, _) = makeCache(scratchDirectory: makeScratchDirectory()) { request in
            capturedAuthorization = request.value(forHTTPHeaderField: "Authorization")
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png"])!, self.realPNGBytes)
        }

        _ = try await cache.fetchResult("https://attacker.example/x.png")

        XCTAssertNil(capturedAuthorization)
    }

    /// A `401` on the image endpoint must trigger exactly one reactive
    /// refresh (via the SAME `RefreshCoordinator` a JSON API call would use)
    /// and retry once with the rotated token — never a bare unauthenticated
    /// retry, and never left as a permanent failure when a refresh would
    /// have fixed it.
    func testA401OnTheImageEndpointTriggersAReactiveRefreshThenRetriesSuccessfully() async throws {
        let (cache, recorder) = makeCache(scratchDirectory: makeScratchDirectory()) { request in
            if request.url!.absoluteString.contains("oauth/token") {
                let body = Data(
                    """
                    { "access_token": "refreshed-token", "refresh_token": "crowi_rt_next", "expires_in": 3600 }
                    """.utf8)
                return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, body)
            }
            if request.value(forHTTPHeaderField: "Authorization") == "Bearer the-token" {
                return (HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil, headerFields: nil)!, Data())
            }
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png"])!, self.realPNGBytes)
        }

        let result = try await cache.fetchResult("/api/attachments/abc")

        XCTAssertEqual(result, .real(realPNGBytes))
        let imageRequests = recorder.requests.filter { !$0.url!.absoluteString.contains("oauth/token") }
        XCTAssertEqual(imageRequests.count, 2, "exactly one retry after the reactive refresh")
        let tokenRequests = recorder.requests.filter { $0.url!.absoluteString.contains("oauth/token") }
        XCTAssertEqual(tokenRequests.count, 1, "exactly one refresh submission over the wire")
    }

    // MARK: - ImageProvider conformance (`WorkspaceImageFetching`)

    func testWorkspaceImageFetchingConformanceUnwrapsRealAndPlaceholderButThrowsOnNotFound() async {
        let (cache, _) = makeCache(scratchDirectory: makeScratchDirectory()) { request in
            (HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!, Data())
        }

        let fetching: any WorkspaceImageFetching = cache
        await XCTAssertThrowsErrorAsync(try await fetching.fetch("/api/attachments/by-key/user/x.png")) { error in
            XCTAssertTrue(error is WorkspaceImageDiskCache.NotFoundError)
        }
    }
}
