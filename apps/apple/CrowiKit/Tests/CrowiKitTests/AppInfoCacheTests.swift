import XCTest

@testable import CrowiKit

/// RFC-0016 §5.2 — `AppInfoCache`'s refresh policy: activation/foreground
/// ALWAYS force a fetch, any other read only forces one once the 10-minute
/// TTL has elapsed, and concurrent callers are single-flighted onto the same
/// in-flight fetch (mirroring `RefreshCoordinator`'s own precedent).
final class AppInfoCacheTests: XCTestCase {
    private func appInfoJSON(capabilities: [String]? = nil, confidential: String? = nil) -> Data {
        var object: [String: Any] = ["title": "Crowi", "version": "2.0.0", "apiVersion": "v2"]
        if let capabilities { object["capabilities"] = capabilities }
        if let confidential { object["confidential"] = confidential }
        return try! JSONSerialization.data(withJSONObject: object)
    }

    private func makeSession(capabilities: [String]? = nil, confidential: String? = nil) -> (URLSession, RequestRecorder) {
        let recorder = RequestRecorder()
        let body = appInfoJSON(capabilities: capabilities, confidential: confidential)
        MockURLProtocol.requestHandler = { request in
            recorder.record(request)
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, body)
        }
        return (MockURLProtocol.makeSession(), recorder)
    }

    func testBeforeFirstFetchCapabilitiesAndConfidentialAreConservativelyUnknown() async {
        let (session, _) = makeSession(capabilities: ["pages"])
        let cache = AppInfoCache(apiBaseURL: APIBaseURL(workspaceOrigin: WorkspaceOrigin(URL(string: "https://wiki.example.com")!)), urlSession: session)

        let capabilities = await cache.capabilities
        let confidential = await cache.confidential

        XCTAssertEqual(capabilities, [], "no fetch has completed yet — must not imply the static baseline OR any host-reported set")
        XCTAssertNil(confidential)
    }

    func testActivatedAlwaysFetchesEvenWithinTTL() async throws {
        let (session, recorder) = makeSession(capabilities: ["pages", "search"])
        let cache = AppInfoCache(
            apiBaseURL: APIBaseURL(workspaceOrigin: WorkspaceOrigin(URL(string: "https://wiki.example.com")!)), urlSession: session, ttl: 600
        )

        _ = try await cache.activated()
        _ = try await cache.activated()

        XCTAssertEqual(recorder.requests.count, 2, "activation always forces a fetch, regardless of TTL")
        let capabilities = await cache.capabilities
        XCTAssertEqual(capabilities, ["pages", "search"])
    }

    func testForegroundedAlwaysFetchesEvenWithinTTL() async throws {
        let (session, recorder) = makeSession(capabilities: ["pages"])
        let cache = AppInfoCache(
            apiBaseURL: APIBaseURL(workspaceOrigin: WorkspaceOrigin(URL(string: "https://wiki.example.com")!)), urlSession: session, ttl: 600
        )

        _ = try await cache.activated()
        _ = try await cache.foregrounded()

        XCTAssertEqual(recorder.requests.count, 2, "foreground always forces a fetch too, even right after activation")
    }

    func testCurrentServesTheCacheWithinTTLWithoutRefetching() async throws {
        let (session, recorder) = makeSession(capabilities: ["pages"])
        let cache = AppInfoCache(
            apiBaseURL: APIBaseURL(workspaceOrigin: WorkspaceOrigin(URL(string: "https://wiki.example.com")!)), urlSession: session, ttl: 600
        )

        _ = try await cache.activated()
        _ = try await cache.current()
        _ = try await cache.current()

        XCTAssertEqual(recorder.requests.count, 1, "a read within the TTL must be served from the cache, not the wire")
    }

    func testCurrentRefetchesOnceTheTTLHasElapsed() async throws {
        let (session, recorder) = makeSession(capabilities: ["pages"])
        let clock = MutableClock(start: Date(timeIntervalSince1970: 0))
        let cache = AppInfoCache(
            apiBaseURL: APIBaseURL(workspaceOrigin: WorkspaceOrigin(URL(string: "https://wiki.example.com")!)),
            urlSession: session,
            ttl: 60,
            now: { clock.date }
        )

        _ = try await cache.activated()
        clock.date.addTimeInterval(61)
        _ = try await cache.current()

        XCTAssertEqual(recorder.requests.count, 2, "a read past the TTL must force a fresh fetch")
    }

    func testConcurrentCallersCoalesceOntoExactlyOneWireFetch() async throws {
        let (session, recorder) = makeSession(capabilities: ["pages"])
        let cache = AppInfoCache(
            apiBaseURL: APIBaseURL(workspaceOrigin: WorkspaceOrigin(URL(string: "https://wiki.example.com")!)), urlSession: session, ttl: 600
        )

        async let first: AppInfoLenient = cache.activated()
        async let second: AppInfoLenient = cache.current()
        async let third: AppInfoLenient = cache.current()
        _ = try await (first, second, third)

        XCTAssertEqual(recorder.requests.count, 1, "concurrent callers right after a workspace switch must single-flight onto ONE fetch")
    }

    func testConfidentialAndCapabilitiesReflectTheLatestFetch() async throws {
        let (session, _) = makeSession(capabilities: ["pages", "search"], confidential: "INTERNAL USE ONLY")
        let cache = AppInfoCache(apiBaseURL: APIBaseURL(workspaceOrigin: WorkspaceOrigin(URL(string: "https://wiki.example.com")!)), urlSession: session)

        _ = try await cache.activated()

        let capabilities = await cache.capabilities
        let confidential = await cache.confidential
        XCTAssertEqual(capabilities, ["pages", "search"])
        XCTAssertEqual(confidential, "INTERNAL USE ONLY")
    }
}

/// A simple mutable "now" for TTL tests — avoids a real `Task.sleep`-based
/// flaky wait.
private final class MutableClock: @unchecked Sendable {
    var date: Date
    init(start: Date) { self.date = start }
}
