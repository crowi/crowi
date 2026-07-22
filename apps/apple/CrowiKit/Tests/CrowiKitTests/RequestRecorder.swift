import Foundation

/// Thread-safe recorder for every HTTP request `MockURLProtocol` actually
/// observed at the transport layer.
///
/// Several §10 single-flight-refresh tests (`RefreshCoordinatorSingleFlightTests`,
/// `AuthenticatingMiddlewareTests`) need to assert "the token endpoint
/// received exactly one refresh submission" as a fact about the WIRE, not
/// about an in-process counter: `RefreshCoordinator.refreshInvocationCount`
/// is incremented by `RefreshCoordinator` itself *before* it calls into
/// `OAuthTokenExchange` — a bug that caused the exchange path to submit the
/// refresh twice over the wire (a retry, `URLSession` re-issuing the
/// request, etc.) would still leave that in-process counter at `1`. Only
/// counting what the mock transport actually received catches that class of
/// bug, which is what AC-5 ("token endpoint への refresh 提示がちょうど 1 回")
/// actually requires.
///
/// `URLProtocol.startLoading()` can run on a different queue per concurrent
/// task, so this needs a lock, not a plain `var`.
final class RequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var _requests: [URLRequest] = []

    func record(_ request: URLRequest) {
        lock.lock()
        _requests.append(request)
        lock.unlock()
    }

    var requests: [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return _requests
    }
}
