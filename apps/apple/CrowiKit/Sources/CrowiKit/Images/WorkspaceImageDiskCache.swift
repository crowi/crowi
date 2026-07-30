import Foundation

/// RFC-0016 §6.1/§7.2 — a per-workspace disk cache WRAPPING
/// `WorkspaceImageLoader` (the proven same-origin-Bearer + redirect-strip
/// transport, Phase 0/1 — this type never re-implements or forks that
/// logic, only adds a cache + the 200-real/200-placeholder/500-error (and
/// 200-real/404-missing/500-error) trichotomy on top of it, per the
/// architecturalNotes' "extend, don't replace" instruction).
///
/// **The two auth-gated URL shapes have DIFFERENT trichotomies** and this
/// type does not conflate them (§6.1 / `attachment-stream.ts`):
///   - embedded `/api/attachments/<id>`: `200` real bytes OR `200`
///     `file-not-found.png` PLACEHOLDER (never cached permanently — the real
///     file may appear on a later fetch) OR `500 UPLOAD_FAILED` (retryable).
///   - avatar `/api/attachments/by-key/<key>`: `200` real bytes OR `404`
///     ATTACHMENT_NOT_FOUND (a genuine "nothing here", never a placeholder)
///     OR `500 UPLOAD_FAILED`.
///
/// Placeholder detection is a byte-identity check against the bundled
/// reference `file-not-found.png` (the RFC's own §6.1 heuristic note: "the
/// `file-not-found.png` is a known fixed asset") — this only ever matters
/// for the embedded shape, since the server never returns a `200` for a
/// missing by-key avatar.
public actor WorkspaceImageDiskCache {
    public enum FetchResult: Equatable, Sendable {
        case real(Data)
        /// Only ever produced for an embedded `/attachments/<id>` URL — a
        /// transient "not available right now" placeholder. NEVER persisted
        /// to disk as if it were the real image (§6.1's hard rule); the next
        /// `fetch` call re-hits the network.
        case placeholder(Data)
        /// A genuine "nothing here" (an avatar `404`, or an embedded id
        /// whose page grant was denied) — distinct from `.placeholder` so
        /// the UI can show a plain "no image" state instead of the
        /// placeholder graphic, and distinct from an error so it is never
        /// offered a retry affordance.
        case notFound
    }

    public enum FetchError: Error, Equatable {
        /// A retryable server/driver fault (§6.1 — `500 UPLOAD_FAILED`).
        case serverError(status: Int)
    }

    private let loader: WorkspaceImageLoader
    private let coordinator: RefreshCoordinator
    private let cacheDirectory: URL
    private let fileManager: FileManager
    private let placeholderReferenceData: Data

    public init(
        loader: WorkspaceImageLoader,
        coordinator: RefreshCoordinator,
        cacheDirectory: URL,
        confidential: Bool = false,
        fileManager: FileManager = .default,
        placeholderReferenceData: Data = WorkspaceImageDiskCache.bundledPlaceholderReferenceData
    ) {
        self.loader = loader
        self.coordinator = coordinator
        self.cacheDirectory = cacheDirectory
        self.fileManager = fileManager
        self.placeholderReferenceData = placeholderReferenceData
        try? fileManager.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)
        WorkspaceModelContainerFactory.applyRestStateProtections(directory: cacheDirectory, confidential: confidential)
    }

    /// Re-applies the §7.2/§6.3 rest-state protection to this workspace's
    /// image cache directory — call whenever `AppInfoCache.confidential`
    /// changes (it is refreshed independently of this cache's own
    /// construction, §5.2), so a workspace that becomes confidential mid-
    /// session gets `.complete` protection on its already-written image
    /// bytes too, not only on the next cold launch.
    public func applyConfidentialProtection(_ confidential: Bool) {
        WorkspaceModelContainerFactory.applyRestStateProtections(directory: cacheDirectory, confidential: confidential)
    }

    /// Fetches `urlString` (rebased + Bearer-gated by `loader`, §6.1),
    /// serving a previously-cached `.real` result from disk without a
    /// network round-trip. `.placeholder` and `.notFound` are never
    /// persisted, so they always re-hit the network on the next call.
    public func fetchResult(_ urlString: String) async throws -> FetchResult {
        let isAvatarShape = urlString.contains("attachments/by-key/")
        let cacheKey = Self.cacheKey(for: urlString)
        if let cached = readCachedRealBytes(cacheKey: cacheKey) {
            return .real(cached)
        }

        do {
            let data = try await fetchWithReactiveRefresh(urlString)
            if !isAvatarShape, data == placeholderReferenceData {
                return .placeholder(data)
            }
            writeCachedRealBytes(data, cacheKey: cacheKey)
            return .real(data)
        } catch let error as WorkspaceImageLoader.LoaderError {
            guard case .httpError(let status) = error else { throw error }
            if status == 404 {
                return .notFound
            }
            throw FetchError.serverError(status: status)
        }
    }

    /// A `401` on the image endpoint is reactively refreshed exactly like
    /// `AuthenticatingMiddleware` does for JSON API calls (§5.1) — using the
    /// SAME `RefreshCoordinator`, so a rotated token is never presented
    /// twice — then retried once. `WorkspaceImageLoader` cannot itself
    /// perform this (its `accessTokenProvider` is a synchronous closure with
    /// no hook to await a refresh), so the wrapper is where this loop lives.
    private func fetchWithReactiveRefresh(_ urlString: String) async throws -> Data {
        do {
            return try await loader.fetch(urlString)
        } catch let error as WorkspaceImageLoader.LoaderError {
            guard case .httpError(let status) = error, status == 401 else { throw error }
            let rejectedToken = try? await coordinator.ensureFreshAccessToken()
            _ = try await coordinator.refreshedAccessToken(rejecting: rejectedToken)
            return try await loader.fetch(urlString)
        }
    }

    // MARK: - Disk persistence (`.real` only)

    private func readCachedRealBytes(cacheKey: String) -> Data? {
        try? Data(contentsOf: cacheFileURL(cacheKey: cacheKey))
    }

    private func writeCachedRealBytes(_ data: Data, cacheKey: String) {
        try? data.write(to: cacheFileURL(cacheKey: cacheKey), options: .atomic)
    }

    private func cacheFileURL(cacheKey: String) -> URL {
        cacheDirectory.appendingPathComponent(cacheKey)
    }

    /// A stable (across launches), filesystem-safe cache filename derived
    /// from the fetched URL string — a pure-Swift FNV-1a 64-bit hash (never
    /// Swift's own `Hasher`, whose per-process seed randomization would
    /// invalidate the cache on every launch).
    static func cacheKey(for urlString: String) -> String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in urlString.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01B3
        }
        return String(format: "%016llx", hash)
    }

    /// The exact bytes of `packages/api/public/images/file-not-found.png`
    /// (`attachment-stream.ts`'s `FILE_NOT_FOUND_IMAGE`) — embedded as a
    /// base64 literal (rather than an SwiftPM `resources:` bundle entry,
    /// keeping this phase's `newDeps`/build-graph footprint at zero) so the
    /// byte-identity placeholder check has a reference to compare against
    /// without a network round-trip.
    public static let bundledPlaceholderReferenceData: Data = {
        // swiftlint:disable:next force_unwrapping — a fixed, checked-in literal.
        Data(
            base64Encoded:
                "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAAAAADmVT4XAAAEjElEQVR4Ae2ZB7KjvBYG3/5XeETGGZxNMDag7xkhGairyTJ/Ule6I1ylntMEh//RX4wV+J6AFbACVsAKWAErYAWsgBWwAlaAOX+RwJoLlik2VIJGbFA7RGdEw8qGBFxwoe/B7z8rgPvhhR+l4RcBnKYC9ZMEaA8vVvQ98PMC5367cikEkqrOPDUBHgoBP6vrm0uXts2pAw0J5PqujMktj7QpN9nj5BDtqmr7CwJlkiQrkgkS3C9tzXqBfV10AqzmWYGK0rY9ygkkL0itH7EiDxml4NkTO1qDZ80vCHRkSuDR+s4Jm14g2WDzEth2Q8qwHBIImFofBA7ko6ACMf3KBK6+77tKgKNjLwWorK+Ijp1QimQQaPwXpNY7AV8IrMlBSU9O5P7yOSAF6tZ3XZcpgZBzRAmORFesRwLUodb3WFMsBFZCoIJP4e8KnHFe3XmgBOgMRF7bpIe2cejZLscCan2NKq1HAgeUu/vvCjg3oN3SW8BtENGyAeqY6AiMBdQ6K8CPIwGWAadWL/ATuAGjLwQ+dTBXv+4wmuC59mH0EQErYAWsgBWwAlbAClgBK3DMsux63C282QX83YFeHNDTFGkwp8Di2oB3O4YcCp6v5hJYFuhIiIhVGFEu5xDwr+gpxg0kF+/jAqsnJK3fNWg5xjyXHxZI1X6yAflBvN7nDRQ8+ajAESMKeuNtcigOpgX0+8sGA3E+GHxKIEVPvcnQsaMJm1q1+ZDASvYvfNpOG0j8AgK+/IiAX0NwdYi8VjQIaIpzheDpfULgJvdn9CLTz5pJg+sHBFZy/g51TBsQ89QMZIWlcQF2R0ctd5INfBKEVXNlk1AlMy2whmBNkkmDHMBp+sKVaYECHRlJJg3YAy+2NNgAuWGBiOMFj0gyacCe4m95MO5fGpoVOMgBDORDA6fvXrnjI3uzAncVVtfAbSC4jc+C0qiALwb+dIg0DcSfgpSETy2OeCYFVprbS/5+HgQck3twho6lSYG9Cq5tEHJIan94aCUmBS7oWGiydA0ivCmd97xO5gTkuHlA+gYLSOS2oTwlDQqUutNqp+44S4zYqtnkxgUaj/QN1hjRRvKqKD4tMDTYYkzl9gL5p8+BocEOE679ZZmZFLiiIyZtAzdBT4OeTAicTQoc5PmlbbBJ0fFceNsWA6lJgTU6LqRtkB17D7UgWZkU6Ks+mLZBkw+BzlDwwKQAq+Qe2gbCDiG9cEpIKmZSgE7fazD+Hwf1cEs0KbCQH8a0DeSx6ceX2KyAbHDWN5jcpvaygFkBOWwef7NB7SrXTD6jzAo4D3TcHX2D8dsl9yH/ZVSAttCehwUko2s0arEl4wJMbnXQN0A1XiyYeQEKW2mgb1DSCJeMCwwRcHF0DYoZvqg8oeceaxpkMwiwK3r4OfjS4DaDwGCA9rJg0waXOQSInfDmcdlG9CKB4PRpAcmuBaa336BfOc4kQGGBgc3QYD+XALHtA4rbcB0kcwhInN19aKCug908AhK2OFX8/T61BK9O/mwCEhasD9dclI83IfvH/mpmBayAFbACVsAKWAErYAX+D1nM672/Zx1YAAAAAElFTkSuQmCC"
        )!
    }()
}

/// `feature-ios-phase1-read` — makes `WorkspaceImageDiskCache` a drop-in
/// substitute for the bare `WorkspaceImageLoader` at every call site that
/// only needs "give me decodable bytes for this URL" (`WorkspaceMarkdownImageProvider`),
/// so the real reader UI can pass the cache instead of a bare loader with NO
/// change to that Phase 0 integration.
extension WorkspaceImageDiskCache: WorkspaceImageFetching {
    /// A single "not found" marker error for `ImageProvider` conformance —
    /// callers that need the real/placeholder/not-found distinction use
    /// `fetchResult(_:)` instead; this unwraps it for a consumer that only
    /// wants "bytes, or nothing to show" (both `.real` and `.placeholder`
    /// ARE valid raster bytes to display — a placeholder is itself a real,
    /// if generic, PNG).
    public struct NotFoundError: Error, Equatable {}

    public func fetch(_ urlString: String) async throws -> Data {
        switch try await fetchResult(urlString) {
        case .real(let data), .placeholder(let data):
            return data
        case .notFound:
            throw NotFoundError()
        }
    }
}
