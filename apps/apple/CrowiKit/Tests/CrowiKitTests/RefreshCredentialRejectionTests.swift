import XCTest

@testable import CrowiKit

/// A refused refresh and an unreachable server look alike from a screen (the
/// request failed), but only the first may end a sign-in: discarding the
/// credential because the server was briefly down would sign the reader out
/// for nothing.
final class RefreshCredentialRejectionTests: XCTestCase {
    private let workspaceId = "workspace-under-test"
    private let expired = StoredTokenPair(accessToken: "stale", refreshToken: "crowi_rt_0", expiresAt: Date().addingTimeInterval(-60))

    private func makeCoordinator(tokenStore: InMemoryTokenStore) -> RefreshCoordinator {
        RefreshCoordinator(
            workspaceId: workspaceId,
            tokenStore: tokenStore,
            urlSession: MockURLProtocol.makeSession(),
            tokenEndpointProvider: { URL(string: "https://wiki.example.com/api/oauth/token")! }
        )
    }

    private func respond(status: Int, body: String) {
        MockURLProtocol.requestHandler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, Data(body.utf8))
        }
    }

    private static let invalidGrant = #"{"error":"invalid_grant","error_description":"Refresh token is invalid, expired, or revoked"}"#

    func testARefusedRefreshTokenRemovesTheCredentialAndAnnouncesIt() async throws {
        let tokenStore = InMemoryTokenStore(seed: [workspaceId: expired])
        respond(status: 400, body: Self.invalidGrant)
        let announced = expectation(forNotification: RefreshCoordinator.credentialRejectedNotification, object: workspaceId)

        do {
            _ = try await makeCoordinator(tokenStore: tokenStore).ensureFreshAccessToken()
            XCTFail("a refused refresh must throw")
        } catch {
            XCTAssertEqual(error as? RefreshCoordinator.RefreshError, .credentialRejected)
        }

        await fulfillment(of: [announced], timeout: 1)
        XCTAssertNil(try tokenStore.load(forWorkspace: workspaceId))
    }

    func testAServerErrorKeepsTheCredential() async throws {
        let tokenStore = InMemoryTokenStore(seed: [workspaceId: expired])
        respond(status: 503, body: "Service Unavailable")

        do {
            _ = try await makeCoordinator(tokenStore: tokenStore).ensureFreshAccessToken()
            XCTFail("a 503 must throw")
        } catch {
            XCTAssertNotEqual(error as? RefreshCoordinator.RefreshError, .credentialRejected)
        }
        XCTAssertEqual(try tokenStore.load(forWorkspace: workspaceId), expired)
    }

    func testALostConnectionKeepsTheCredential() async throws {
        let tokenStore = InMemoryTokenStore(seed: [workspaceId: expired])
        MockURLProtocol.requestHandler = { _ in throw URLError(.cannotConnectToHost) }

        do {
            _ = try await makeCoordinator(tokenStore: tokenStore).ensureFreshAccessToken()
            XCTFail("an unreachable server must throw")
        } catch {
            XCTAssertNotEqual(error as? RefreshCoordinator.RefreshError, .credentialRejected)
        }
        XCTAssertEqual(try tokenStore.load(forWorkspace: workspaceId), expired)
    }

    /// Other OAuth errors are not a verdict on this credential: an
    /// `invalid_client` means the server lost the app's registration, which a
    /// fresh sign-in would hit just the same.
    func testAnErrorOtherThanInvalidGrantKeepsTheCredential() async throws {
        let tokenStore = InMemoryTokenStore(seed: [workspaceId: expired])
        respond(status: 401, body: #"{"error":"invalid_client"}"#)

        _ = try? await makeCoordinator(tokenStore: tokenStore).ensureFreshAccessToken()

        XCTAssertEqual(try tokenStore.load(forWorkspace: workspaceId), expired)
    }

    /// The server refuses the loser of two refreshes racing on one token with
    /// the same `invalid_grant`. When the winner's successor is already
    /// stored, that is a working sign-in and must be kept.
    func testARefusalOfATokenAlreadyRotatedAwayAdoptsTheStoredSuccessor() async throws {
        let tokenStore = InMemoryTokenStore(seed: [workspaceId: expired])
        let successor = StoredTokenPair(accessToken: "winner", refreshToken: "crowi_rt_1", expiresAt: Date().addingTimeInterval(3600))
        MockURLProtocol.requestHandler = { [workspaceId] request in
            try tokenStore.save(successor, forWorkspace: workspaceId)
            return (HTTPURLResponse(url: request.url!, statusCode: 400, httpVersion: nil, headerFields: nil)!, Data(Self.invalidGrant.utf8))
        }

        let token = try await makeCoordinator(tokenStore: tokenStore).ensureFreshAccessToken()

        XCTAssertEqual(token, "winner")
        XCTAssertEqual(try tokenStore.load(forWorkspace: workspaceId), successor)
    }
}
