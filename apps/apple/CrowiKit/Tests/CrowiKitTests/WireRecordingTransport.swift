import Foundation
import HTTPTypes
import OpenAPIRuntime

@testable import CrowiKit

/// One request as the mock transport actually observed it — method, path,
/// headers, and the fully-collected JSON body. `feature-ios-phase2-write`'s
/// wire-level assertions (`PageCreateFlowTests` / `PageEditSessionTests` /
/// `EngagementActionsTests`) are facts about THIS, not about any in-process
/// counter — the same rationale as `RequestRecorder` for the refresh tests.
struct RecordedWireRequest: Sendable {
    let method: HTTPRequest.Method
    let path: String?
    let contentType: String?
    let authorization: String?
    let body: Data?

    /// The request body parsed as a JSON object (`nil` when absent or not
    /// an object) — for asserting key presence/absence (e.g. "`grant` is
    /// OMITTED", "`revision_id` is ALWAYS present").
    var jsonObject: [String: Any]? {
        guard let body else { return nil }
        return (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
    }
}

/// Thread-safe recorder for `RecordedWireRequest`s (the `RequestRecorder`
/// shape, at the `ClientTransport` layer instead of `URLProtocol`).
final class WireRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var _requests: [RecordedWireRequest] = []

    func record(_ request: RecordedWireRequest) {
        lock.lock()
        _requests.append(request)
        lock.unlock()
    }

    var requests: [RecordedWireRequest] {
        lock.lock()
        defer { lock.unlock() }
        return _requests
    }
}

/// The scripted mock `ClientTransport` behind `makeWireRecordedClient`:
/// collects the request body before handing the request to the scripted
/// handler, and lets the handler THROW (a thrown `URLError` is the §7.4
/// offline fixture) or SUSPEND (an `async` handler parked on a latch is the
/// deterministic "request in flight" fixture the duplicate-tap guard tests
/// need — a plain synchronous closure converts implicitly).
struct WireRecordingTransport: ClientTransport {
    let recorder: WireRecorder
    let handler: @Sendable (RecordedWireRequest) async throws -> (Int, Data)

    func send(_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String) async throws -> (HTTPResponse, HTTPBody?) {
        var bodyData: Data?
        if let body {
            bodyData = try await Data(collecting: body, upTo: 1 << 20)
        }
        let recorded = RecordedWireRequest(
            method: request.method,
            path: request.path,
            contentType: request.headerFields[.contentType],
            authorization: request.headerFields[.authorization],
            body: bodyData
        )
        recorder.record(recorded)
        let (status, data) = try await handler(recorded)
        return (HTTPResponse(status: .init(code: status)), HTTPBody(data))
    }
}

/// An `AuthenticatedAPIClient` over `WireRecordingTransport` with a
/// non-expiring seeded token — shared here because every client/write-flow
/// test file needs the same composition.
func makeWireRecordedClient(
    recorder: WireRecorder,
    handler: @escaping @Sendable (RecordedWireRequest) async throws -> (Int, Data)
) -> AuthenticatedAPIClient {
    let tokenStore = InMemoryTokenStore(seed: [
        "workspace-a": StoredTokenPair(accessToken: "the-token", refreshToken: "rt-1", expiresAt: Date().addingTimeInterval(3600))
    ])
    let coordinator = RefreshCoordinator(workspaceId: "workspace-a", tokenStore: tokenStore, urlSession: .shared) {
        URL(string: "https://wiki.example.com/api/v2/oauth/token")!
    }
    return AuthenticatedAPIClient(
        apiBaseURL: APIBaseURL(workspaceOrigin: WorkspaceOrigin(URL(string: "https://wiki.example.com")!)),
        middleware: AuthenticatingMiddleware(coordinator: coordinator),
        transport: WireRecordingTransport(recorder: recorder, handler: handler)
    )
}
