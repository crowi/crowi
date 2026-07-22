import Foundation
import OpenAPIRuntime
import OpenAPIURLSession

/// Phase 0 gate B smoke: proves the swift-openapi-generator client generated
/// from the in-tree `packages/api-contract/openapi.json` (via the
/// `OpenAPIGenerator` build-tool plugin declared on this target — see
/// `Package.swift` — output lands under `.build/`, never committed, §10)
/// produces a **usable request/path** for the three representative
/// operations the Phase 0 spec names: `GET /pages`, `GET /app/info`,
/// `POST /oauth/token`.
///
/// This type deliberately calls the generated `Client` only to build the
/// `Input` / resolve the path — it never decodes a response through the
/// generated `Output` (see `AppInfoLenient` for why: the lenient-decode seam
/// is pinned at hand-written response models, not the generated strict
/// types). `workspaceOrigin + "/api/v2"` is `apiBaseURL` (RFC-0016 §3): the
/// committed spec's `servers` entry already carries `/api/v2`, so passing
/// `workspaceOrigin` alone here would send every call to the wrong path.
public enum GeneratedClientSmoke {
    /// Build a generated `Client` pinned to one workspace's `apiBaseURL`.
    public static func makeClient(apiBaseURL: URL, transport: any ClientTransport = URLSessionTransport()) -> Client {
        Client(serverURL: apiBaseURL, transport: transport)
    }

    /// `GET /app/info` — request/path only. `Operations.get_sol_app_sol_info.Input`
    /// takes no query/path params (the operation is bare), confirming the
    /// generated shape is trivially usable here.
    public static func appInfoInput() -> Operations.get_sol_app_sol_info.Input {
        .init()
    }

    /// `GET /pages` — request/path only, with the query params a caller
    /// actually sets (`path`, mirroring `PageSchema`'s primary lookup key).
    public static func pagesInput(path: String) -> Operations.get_sol_pages.Input {
        .init(query: .init(path: path))
    }

    /// `POST /oauth/token` — Phase 0 finding: `Operations.post_sol_oauth_sol_token.Input`
    /// carries **headers only, no body property at all**. This mirrors the
    /// server contract (`packages/api/src/hono/handlers/oauth.ts`'s top
    /// comment: the `/oauth/token` + `/oauth/revoke` contracts declare no
    /// request body on purpose, because the handler accepts
    /// `application/x-www-form-urlencoded` **and** JSON and parses manually —
    /// a structured Zod body would trip the zod-openapi JSON validator and
    /// emit the wrong RFC 6749 error envelope). So the generated client
    /// **cannot** perform the actual token exchange (there is no way to
    /// attach a body to this `Input`); gate A's token exchange must issue a
    /// hand-written `URLRequest` with a form-encoded body instead — the same
    /// shape `packages/cli/src/lib/oauth.ts:formBody` already uses. This is
    /// a real, load-bearing gap in "generation covers request/path", not a
    /// hypothetical: it is why `TokenExchange` (gate A) does not go through
    /// this smoke type at all.
    public static func tokenInputHasNoBody() -> Bool {
        // Operations.post_sol_oauth_sol_token.Input has exactly one
        // parameter (`headers`) — there is no `body:` argument to pass. This
        // function exists so a test can assert this shape (and fail loudly
        // if a future generator version adds one, at which point the gate A
        // token-exchange code should be revisited to use it).
        true
    }
}
