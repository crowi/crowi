import Foundation

/// RFC-0016 §3 — `workspaceOrigin + "/api"`. This is what the generated
/// `Client(serverURL:)` is constructed with, and what every OAuth endpoint
/// (`/oauth/authorize`, `/oauth/token`) and the `/app/info` probe is built
/// on. **Load-bearing distinction from `WorkspaceOrigin`**: the committed
/// `openapi.json` carries `/api` in its `servers` entry while operation
/// `path`s are bare (`/pages`, …), so the generated client expects its
/// `serverURL` to already include `/api`. Passing a `WorkspaceOrigin`
/// alone to `Client(serverURL:)` would send every call to the wrong path
/// (e.g. `https://host/pages` instead of `https://host/api/pages`) and
/// 404 — the exact conflation §3 forbids.
///
/// There is **deliberately no initializer from a raw `URL`**: the only way to
/// construct an `APIBaseURL` is from a `WorkspaceOrigin`, so the two newtypes
/// can never be silently interchanged (no raw-URL passthrough between them,
/// per the reuse-target note in the Phase 1 spec's `context.newFiles`).
public struct APIBaseURL: Equatable, Sendable, Hashable {
    public let url: URL

    public init(workspaceOrigin: WorkspaceOrigin) {
        self.url = workspaceOrigin.baseURL.appendingPathComponent("api")
    }
}

extension APIBaseURL {
    /// `{apiBaseURL}/<path>` — the only sanctioned way to build an API URL
    /// (never string-concatenate `workspaceOrigin` + a hand-written
    /// `"/api/..."` prefix, which is exactly the mistake this type
    /// prevents structurally).
    public func appending(_ path: String) -> URL {
        url.appendingPathComponent(path)
    }
}
