import XCTest

@testable import CrowiKit

/// RFC-0016 §4.2/§5.1/OQ-3 — the CI-fixed single-flight invariant: N
/// concurrent callers (mixing the PROACTIVE `ensureFreshAccessToken()` path
/// and the REACTIVE `refreshedAccessToken()` backstop) against an
/// already-expired stored token must present the refresh token to the token
/// endpoint **exactly once** — a second concurrent presentation would trip
/// the server's `revokeChain` reuse-detection and kill the whole workspace
/// (`packages/api/src/hono/handlers/oauth.ts`).
final class RefreshCoordinatorSingleFlightTests: XCTestCase {
    private let workspaceId = "workspace-under-test"

    private func makeCoordinator(tokenStore: InMemoryTokenStore, urlSession: URLSession) -> RefreshCoordinator {
        RefreshCoordinator(
            workspaceId: workspaceId,
            tokenStore: tokenStore,
            urlSession: urlSession,
            tokenEndpointProvider: { URL(string: "https://wiki.example.com/api/v2/oauth/token")! }
        )
    }

    func testConcurrentProactiveCallersCoalesceOntoOneRefresh() async throws {
        let tokenStore = InMemoryTokenStore(seed: [
            workspaceId: StoredTokenPair(accessToken: "stale", refreshToken: "crowi_rt_0", expiresAt: Date().addingTimeInterval(-60))
        ])
        let (urlSession, recorder) = MockURLProtocol.makeRefreshingSession()
        let coordinator = makeCoordinator(tokenStore: tokenStore, urlSession: urlSession)

        let results = try await withThrowingTaskGroup(of: String.self) { group in
            for _ in 0..<20 {
                group.addTask { try await coordinator.ensureFreshAccessToken() }
            }
            var collected: [String] = []
            for try await value in group {
                collected.append(value)
            }
            return collected
        }

        XCTAssertEqual(results.count, 20)
        XCTAssertEqual(Set(results).count, 1, "every concurrent caller must observe the SAME refreshed access token")
        let invocationCount = await coordinator.refreshInvocationCount
        XCTAssertEqual(invocationCount, 1, "the in-process refresh-attempt counter must be exactly 1")
        XCTAssertEqual(recorder.requests.count, 1, "the mock token endpoint must have received exactly ONE refresh submission over the wire, regardless of concurrent callers")
    }

    /// The AC-2 scenario in the spec's own words: hitting the API
    /// concurrently with an expired access token must not trip
    /// `revokeChain` — modeled here as a mix of proactive and reactive
    /// (401-backstop) callers, all coalescing onto one refresh.
    func testMixedProactiveAndReactiveCallersStillCoalesce() async throws {
        let tokenStore = InMemoryTokenStore(seed: [
            workspaceId: StoredTokenPair(accessToken: "stale", refreshToken: "crowi_rt_0", expiresAt: Date().addingTimeInterval(-60))
        ])
        let (urlSession, recorder) = MockURLProtocol.makeRefreshingSession()
        let coordinator = makeCoordinator(tokenStore: tokenStore, urlSession: urlSession)

        try await withThrowingTaskGroup(of: String.self) { group in
            for i in 0..<10 {
                if i % 2 == 0 {
                    group.addTask { try await coordinator.ensureFreshAccessToken() }
                } else {
                    group.addTask { try await coordinator.refreshedAccessToken() }
                }
            }
            for try await _ in group {}
        }

        let invocationCount = await coordinator.refreshInvocationCount
        XCTAssertEqual(invocationCount, 1)
        XCTAssertEqual(recorder.requests.count, 1, "the mock token endpoint must have received exactly ONE refresh submission over the wire, regardless of concurrent callers")
    }

    func testSequentialRefreshesAfterCompletionEachHitTheEndpointAgain() async throws {
        let tokenStore = InMemoryTokenStore(seed: [
            workspaceId: StoredTokenPair(accessToken: "stale", refreshToken: "crowi_rt_0", expiresAt: Date().addingTimeInterval(-60))
        ])
        let (urlSession, recorder) = MockURLProtocol.makeRefreshingSession()
        let coordinator = makeCoordinator(tokenStore: tokenStore, urlSession: urlSession)

        _ = try await coordinator.refreshedAccessToken()
        _ = try await coordinator.refreshedAccessToken()

        // Sequential (non-overlapping) refreshes are NOT single-flighted —
        // each is a legitimately separate refresh cycle.
        let invocationCount = await coordinator.refreshInvocationCount
        XCTAssertEqual(invocationCount, 2)
        XCTAssertEqual(recorder.requests.count, 2, "two non-overlapping refresh cycles must each submit their own request over the wire")
    }

    func testFreshTokenIsReturnedWithoutRefreshing() async throws {
        let tokenStore = InMemoryTokenStore(seed: [
            workspaceId: StoredTokenPair(accessToken: "still-fresh", refreshToken: "crowi_rt_0", expiresAt: Date().addingTimeInterval(3600))
        ])
        let (urlSession, recorder) = MockURLProtocol.makeRefreshingSession()
        let coordinator = makeCoordinator(tokenStore: tokenStore, urlSession: urlSession)

        let token = try await coordinator.ensureFreshAccessToken()

        XCTAssertEqual(token, "still-fresh")
        let invocationCount = await coordinator.refreshInvocationCount
        XCTAssertEqual(invocationCount, 0)
        XCTAssertEqual(recorder.requests.count, 0, "a still-fresh token must never hit the wire")
    }

    func testNoStoredTokenThrows() async {
        let tokenStore = InMemoryTokenStore()
        let (urlSession, _) = MockURLProtocol.makeRefreshingSession()
        let coordinator = makeCoordinator(tokenStore: tokenStore, urlSession: urlSession)

        do {
            _ = try await coordinator.ensureFreshAccessToken()
            XCTFail("expected noStoredRefreshToken")
        } catch RefreshCoordinator.RefreshError.noStoredRefreshToken {
            // expected
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }
}
