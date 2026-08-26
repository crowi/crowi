import Foundation

/// RFC-0016 §3 add-flow — orchestrates the four add-workspace steps in
/// order: URL normalization → HTTPS gate → lenient `/app/info` probe →
/// minimum-version gate → OAuth sign-in. Each step's dependency is
/// injectable so `AddWorkspaceFlowTests`/`HTTPSGateTests` can fix the probe
/// response and the ASWAS presenter without any real network or UI.
public enum AddWorkspaceFlow {
    /// The successful result — everything `WorkspaceStore.finishAdding`
    /// needs to persist a new workspace (index entry + Keychain item).
    public struct Onboarded: Sendable, Equatable {
        public let workspaceOrigin: WorkspaceOrigin
        public let displayTitle: String
        public let tokens: StoredTokenPair
    }

    public enum AddWorkspaceError: Error, Equatable {
        /// The user's input could not be parsed as a URL with a host at all.
        case invalidURL
        /// A cleartext `http` origin that isn't the narrow local/dev
        /// exemption (`localhost` / `127.0.0.1` / `*.local`) — refused
        /// before any network call, per §3/§14.
        case insecureOrigin(WorkspaceOrigin)
        /// The `/app/info` probe request itself failed (unreachable host,
        /// non-2xx, or an unparseable body) — distinct from `notACrowiHost`,
        /// which is a *successful* probe whose payload doesn't look like Crowi.
        case hostUnreachable
        /// The probe succeeded but the payload has no `version` at all — not
        /// a Crowi host (§3 step 2), as opposed to an old Crowi that merely
        /// omits `capabilities` (which degrades to the static baseline
        /// instead of being rejected here).
        case notACrowiHost
        /// The host is a Crowi below `MinimumVersionFloor.floor` — refused,
        /// no fallback (§3 step 3 / §4.4).
        case tooOld(hostVersion: String, floor: String)
        /// The host's `version` did not parse as a semver at all — fails
        /// closed, same refusal as `tooOld`.
        case unparseableVersion(hostVersion: String)
    }

    /// Runs the full add-workspace pipeline.
    ///
    /// - Parameters:
    ///   - userInput: free-form host text the user typed (§3 step 1).
    ///   - probe: performs the lenient `/app/info` GET; defaults to the real
    ///     network call, overridden by tests with a fixed fixture.
    ///   - presentSession: the ASWAS presenter `OAuthSignInFlow.signIn` uses;
    ///     production callers pass `ASWebAuthenticationSessionRunner.run`.
    ///   - floor: overridable only for tests — production always uses
    ///     `MinimumVersionFloor.floor` (the single source, AC-4).
    /// - Parameters:
    ///   - allowedInsecureHosts: Developer Mode's per-host `http` exemption
    ///     (`AppSettings.allowedInsecureHosts`, lowercased) — empty unless
    ///     the caller has already confirmed Developer Mode is on. Compared
    ///     against `WorkspaceOrigin.host` only (never scheme/port), the same
    ///     granularity as the built-in `localhost`/`127.0.0.1`/`*.local`
    ///     exemption it extends.
    public static func addWorkspace(
        userInput: String,
        allowedInsecureHosts: Set<String> = [],
        probe: @Sendable (APIBaseURL) async throws -> AppInfoLenient = { try await AppInfoLenient.fetch(apiBaseURL: $0) },
        presentSession: @Sendable (_ authorizeURL: URL) async throws -> URL,
        floor: String = MinimumVersionFloor.floor,
        urlSession: URLSession = .shared
    ) async throws -> Onboarded {
        guard let origin = WorkspaceOrigin.normalize(userInput: userInput) else {
            throw AddWorkspaceError.invalidURL
        }
        try assertHTTPSGate(origin, allowedInsecureHosts: allowedInsecureHosts)

        let apiBaseURL = APIBaseURL(workspaceOrigin: origin)
        let info: AppInfoLenient
        do {
            info = try await probe(apiBaseURL)
        } catch {
            throw AddWorkspaceError.hostUnreachable
        }
        guard info.looksLikeCrowiHost else {
            throw AddWorkspaceError.notACrowiHost
        }

        switch MinimumVersionFloor.evaluate(hostVersion: info.version, floor: floor) {
        case .ok:
            break
        case .tooOld(let hostVersion, let floorValue):
            throw AddWorkspaceError.tooOld(hostVersion: hostVersion, floor: floorValue)
        case .unparseable(let hostVersion):
            throw AddWorkspaceError.unparseableVersion(hostVersion: hostVersion)
        }

        let tokens = try await OAuthSignInFlow.signIn(workspaceOrigin: origin, presentSession: presentSession, urlSession: urlSession)
        return Onboarded(workspaceOrigin: origin, displayTitle: info.title ?? origin.host, tokens: tokens)
    }

    /// The §3/§14 HTTPS gate, in isolation — `https` always passes; `http`
    /// passes for `localhost` / `127.0.0.1` / `*.local` (always) or a host in
    /// `allowedInsecureHosts` (Developer Mode's per-workspace opt-in);
    /// everything else throws `insecureOrigin`. Internal (not `private`) so
    /// `HTTPSGateTests` can exercise it directly without running the whole
    /// pipeline (which would also require a probe + sign-in stub).
    ///
    /// Not a way around iOS's own App Transport Security: a host that isn't
    /// actually on a private network still fails at the OS level the moment
    /// the probe request goes out, regardless of what's in this set. This
    /// gate only decides whether the APP is willing to try.
    static func assertHTTPSGate(_ origin: WorkspaceOrigin, allowedInsecureHosts: Set<String> = []) throws {
        if origin.isHTTPS { return }
        guard origin.scheme == "http", origin.isExemptLocalHost || allowedInsecureHosts.contains(origin.host) else {
            throw AddWorkspaceError.insecureOrigin(origin)
        }
    }
}
