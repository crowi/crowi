import Foundation

/// RFC-0016 §5.2 — lenient decode of `GET /search`
/// (`SearchPagesResponseSchema`), capability-gated on `search` in the
/// refreshed `AppInfoCache` (§5.2 — a host without an active search driver
/// returns `503 { feature: 'search' }`, so `SearchView` must hide itself
/// rather than let the user hit that).
public enum SearchLenientDecodeError: Error, Equatable {
    case notAnObject
    case httpError(status: Int)
    /// The refreshed `AppInfoCache.capabilities` did not contain `search` —
    /// the app should hide the search UI rather than call this endpoint at
    /// all; surfaced as a distinct case so a caller that DOES call anyway
    /// gets a clear signal instead of a raw `503`.
    case searchCapabilityUnavailable
}

public struct SearchHitLenient: Sendable, Equatable {
    public let pageId: String
    public let path: String
    public let score: Double?
    /// The driver-supplied highlight string, carrying **unescaped**
    /// `<mark>` tokens verbatim (the server does not sanitize it, §5.2's
    /// `newFiles` note) — NEVER render this raw. Use
    /// `SearchHitLenient.plainSnippet(_:)` (strips every tag) for a
    /// native `Text`, since there is no HTML/DOM render context to safely
    /// interpret `<mark>` in (consistent with §6.1's raster-only-decode /
    /// never-a-web-context invariant for untrusted server content).
    public let rawSnippet: String?
    public let bookmarkCount: Int?
    public let page: PageLenient?

    static func decode(_ object: [String: Any]) -> SearchHitLenient? {
        guard let pageId = object["pageId"] as? String, let path = object["path"] as? String else { return nil }
        return SearchHitLenient(
            pageId: pageId,
            path: path,
            score: object["score"] as? Double,
            rawSnippet: object["snippet"] as? String,
            bookmarkCount: object["bookmarkCount"] as? Int,
            page: (object["page"] as? [String: Any]).flatMap(PageLenient.decode)
        )
    }

    /// Strips every `<...>` tag (in practice just the driver's `<mark>` /
    /// `</mark>` highlight wrapper) so the snippet is safe to place in a
    /// native `Text` view — never parsed/rendered as markup.
    ///
    /// Implemented on top of `snippetSegments(_:)` so the two can never
    /// disagree about what a tag is: the plain string is by construction the
    /// concatenation of the segmented one (pinned by `SearchLenientTests`).
    public static func plainSnippet(_ rawSnippet: String) -> String {
        snippetSegments(rawSnippet).map(\.text).joined()
    }

    /// One run of snippet text, and whether the driver marked it as a query
    /// hit.
    public struct SnippetSegment: Sendable, Equatable {
        /// Tag-free text, exactly as it appears in `plainSnippet`.
        public let text: String
        /// `true` inside a `<mark>…</mark>` span.
        public let isHighlighted: Bool

        public init(text: String, isHighlighted: Bool) {
            self.text = text
            self.isHighlighted = isHighlighted
        }
    }

    /// Splits the driver's highlight string into hit / non-hit runs.
    ///
    /// The search backend really does supply hit positions: the Elasticsearch
    /// driver configures `pre_tags:['<mark>'] / post_tags:['</mark>']`
    /// (`packages/plugin-search-elasticsearch/src/query-builder.ts`) and the
    /// handler passes the fragment through untouched, which is the same
    /// signal the web renders as its yellow `[&_mark]` highlight
    /// (`packages/web/src/components/search/search-hit-snippet.tsx`). So iOS
    /// can highlight too — it just cannot do it the web's way.
    ///
    /// **This is a segmenter, not a parser.** The string is untrusted
    /// (unescaped, driver-supplied, containing page body text), there is no
    /// HTML/DOM render context on this side to interpret it in safely (§6.1's
    /// raster-only-decode / never-a-web-context invariant), and none is
    /// introduced here: the output is plain `String` runs plus a `Bool`. Every
    /// tag that is not a bare `<mark>` / `</mark>` is DROPPED exactly as
    /// `plainSnippet` always dropped it — deliberately not the web
    /// sanitiser's "escape it so it shows up literally" rule, which would
    /// change what existing hits render.
    ///
    /// Matching mirrors `packages/web/src/lib/sanitise-snippet.ts`:
    /// case-insensitive, attributes on the open tag tolerated, a self-closing
    /// `<mark/>` rejected, and an orphan `</mark>` dropped rather than
    /// allowed to underflow the depth.
    public static func snippetSegments(_ rawSnippet: String) -> [SnippetSegment] {
        var segments: [SnippetSegment] = []
        var buffer = ""
        var depth = 0
        var insideTag = false
        var tag = ""

        // Coalesces into the previous run when the highlight state matches,
        // so `</mark><mark>` (adjacent hits with nothing between them) yields
        // ONE highlighted run rather than two — the output stays canonical,
        // which is what makes it comparable in tests.
        func flush() {
            guard !buffer.isEmpty else { return }
            let isHighlighted = depth > 0
            if let last = segments.last, last.isHighlighted == isHighlighted {
                segments[segments.count - 1] = SnippetSegment(text: last.text + buffer, isHighlighted: isHighlighted)
            } else {
                segments.append(SnippetSegment(text: buffer, isHighlighted: isHighlighted))
            }
            buffer = ""
        }

        for character in rawSnippet {
            if character == "<" {
                insideTag = true
                tag = ""
            } else if character == ">" {
                if insideTag {
                    switch classifyTag(tag) {
                    case .markOpen:
                        flush()
                        depth += 1
                    case .markClose:
                        flush()
                        depth = max(0, depth - 1)
                    case .other:
                        break
                    }
                }
                insideTag = false
            } else if insideTag {
                tag.append(character)
            } else {
                buffer.append(character)
            }
        }
        flush()
        return segments
    }

    private enum SnippetTagKind {
        case markOpen
        case markClose
        case other
    }

    /// - Parameter tag: the text BETWEEN `<` and `>`, e.g. `mark`,
    ///   `mark class="hit"`, `/mark`.
    private static func classifyTag(_ tag: String) -> SnippetTagKind {
        let lowercased = tag.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if lowercased.hasPrefix("/mark"), lowercased.dropFirst(5).allSatisfy(\.isWhitespace) {
            return .markClose
        }
        // `<mark/>` opens nothing — matching the web sanitiser's
        // self-closing rejection, so it cannot leave the depth stuck open.
        guard !lowercased.hasSuffix("/") else { return .other }
        if lowercased == "mark" {
            return .markOpen
        }
        if lowercased.hasPrefix("mark"), let next = lowercased.dropFirst(4).first, next.isWhitespace {
            return .markOpen
        }
        return .other
    }
}

public struct SearchPagesResponseLenient: Sendable, Equatable {
    public let total: Int
    public let results: Int
    public let hits: [SearchHitLenient]

    public static func decode(_ data: Data) throws -> SearchPagesResponseLenient {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw SearchLenientDecodeError.notAnObject
        }
        let meta = object["meta"] as? [String: Any] ?? [:]
        let rawHits = object["data"] as? [[String: Any]] ?? []
        return SearchPagesResponseLenient(
            total: meta["total"] as? Int ?? 0,
            results: meta["results"] as? Int ?? rawHits.count,
            hits: rawHits.compactMap(SearchHitLenient.decode)
        )
    }

    /// - Parameter capabilities: the refreshed `AppInfoCache.capabilities`
    ///   the caller already holds — checked here (not just left to the UI
    ///   layer) so no call site can accidentally skip the capability gate.
    public static func fetch(
        query: String,
        capabilities: [String],
        page: Int = 1,
        limit: Int = 50,
        using client: AuthenticatedAPIClient
    ) async throws -> SearchPagesResponseLenient {
        guard capabilities.contains("search") else {
            throw SearchLenientDecodeError.searchCapabilityUnavailable
        }
        let (data, status) = try await client.get(
            "search",
            query: [
                URLQueryItem(name: "q", value: query),
                URLQueryItem(name: "page", value: String(page)),
                URLQueryItem(name: "limit", value: String(limit)),
            ]
        )
        guard status.isSuccessfulHTTPStatus else { throw SearchLenientDecodeError.httpError(status: status) }
        return try decode(data)
    }
}
