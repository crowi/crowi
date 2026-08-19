import Foundation
import XCTest

@testable import CrowiKit

/// RFC-0023 Phase 4 — the CONSUMER side of the shared golden corpus
/// (`packages/api/src/renderer/__fixtures__/golden-corpus/*.json`).
///
/// The api jest driver (`packages/api/src/renderer/golden-corpus.test.ts`)
/// asserts the PRODUCER side (markdown → `expectedAst` via the real
/// pipeline, and `storedAst`/`expectedAst` → `expectedEnvelope` via
/// `sanitizeAst`). This suite asserts the consumer side, per each file's
/// `consumerContract`:
///
///   1. **strict envelope decode** — `expectedEnvelope` decodes without an
///      envelope-level failure, and re-encoding the decoded tree reproduces
///      the envelope's `root` (nothing rendering-significant is dropped:
///      heading anchor ids, GFM `table.align` null entries, three-valued
///      `listItem.checked`, `list.start`, emoji a11y `hName`/`hProperties`/
///      `hChildren`, wikilink/mention `className` stamps, shiki token
///      lines/fontStyle, `data-crowi-image-*` …);
///   2. **sanitise-walker mirror** — walking the STORED bare `Root`
///      (`storedAst`/`expectedAst`) yields exactly the decoded envelope
///      (the same per-node degrades: `invalid-shape` → `crowiOpaque`,
///      URL-scheme violations → `'#'`, …).
///
/// Null-vs-absent: the consumer maps a JSON `null` field to "no value"
/// (they are semantically identical on the render side — a `checked: null`
/// list item is a plain item), so the comparison normalizes `null` DICT
/// entries away on the expected side; `table.align`'s positional in-array
/// nulls are preserved on both sides.
///
/// Like `PageRowTitleLabelTests`, this reads the repo tree via `#filePath`
/// and therefore runs where `swift test` runs (the host mac). The corpus
/// files pin THIS file's path in their `consumers` arrays — moving either
/// side requires updating both.
final class RenderedAstGoldenCorpusTests: XCTestCase {
    /// `<repo>/apps/apple/CrowiKit/Tests/CrowiKitTests/<this file>` → `<repo>`.
    private static var repositoryRootURL: URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { url = url.deletingLastPathComponent() }
        return url
    }

    private static let corpusDirectoryURL = repositoryRootURL
        .appendingPathComponent("packages/api/src/renderer/__fixtures__/golden-corpus")

    /// Every corpus file this consumer asserts against.
    ///
    /// Kept in step with the directory by `testEveryCorpusFileIsRegistered`
    /// below — a fixture added upstream and not listed here is read by
    /// nobody, and the suite still passes, so the gap is invisible exactly
    /// when it matters.
    private static let corpusFiles = [
        "core-blocks", "inline", "code", "image-attrs", "gfm-references", "typed-nodes",
        "frontmatter", "github-alerts",
    ]

    /// Files whose stored shape is projected to v1 by a rule that exists ONLY
    /// on the server, so this walker cannot reproduce the envelope from it.
    ///
    /// `crowiAlert` is the case: it is deliberately outside the v1 union, the
    /// server narrows it to a `blockquote`, and a client that met the stored
    /// form would treat it as an unknown type. It never meets one — the
    /// envelope is all a client is ever sent — so the walk being unreproducible
    /// costs nothing, but asserting it would be asserting a path that does not
    /// exist. Their `expectedEnvelope` is still decoded and round-tripped by
    /// the other two tests, which is the half that runs in production.
    ///
    /// Raised with the contract's owners; if the mirror is meant to hold here,
    /// it needs the projection on this side and this set goes away.
    private static let serverOnlyProjectionFiles: Set<String> = ["github-alerts"]

    private struct CorpusCase {
        let file: String
        let name: String
        let raw: [String: Any]

        var expectedEnvelope: [String: Any]? { raw["expectedEnvelope"] as? [String: Any] }
        /// The stored-AST side: degrade cases carry `storedAst`, happy-path
        /// cases reuse `expectedAst` (the stored AST IS the parser output).
        var storedRoot: [String: Any]? {
            (raw["storedAst"] as? [String: Any]) ?? (raw["expectedAst"] as? [String: Any])
        }
    }

    private func loadFile(_ name: String) throws -> (consumers: [String], cases: [CorpusCase]) {
        let url = Self.corpusDirectoryURL.appendingPathComponent("\(name).json")
        guard FileManager.default.fileExists(atPath: url.path) else {
            XCTFail(
                """
                Shared golden corpus file not found at \(url.path).
                It is the single expectation set the api jest driver and this
                Swift consumer both read. If it moved, update BOTH consumers
                (each file's own `consumers` array records them).
                """
            )
            throw CocoaError(.fileNoSuchFile)
        }
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
        guard let dict = object as? [String: Any], let rawCases = dict["cases"] as? [[String: Any]] else {
            XCTFail("\(name).json is not a corpus file (no cases array)")
            throw CocoaError(.fileReadCorruptFile)
        }
        let cases = rawCases.map { CorpusCase(file: name, name: ($0["name"] as? String) ?? "<unnamed>", raw: $0) }
        return (consumers: dict["consumers"] as? [String] ?? [], cases: cases)
    }

    /// A truncated / emptied corpus must not pass as "all cases green" —
    /// the `PageRowTitleLabelTests` count-floor pattern.
    func testCorpusFilesAreLoadableAndSubstantial() throws {
        var total = 0
        for file in Self.corpusFiles {
            let loaded = try loadFile(file)
            // A floor of two still catches the emptied and the truncated file,
            // which is what this guards. Five was written when every fixture
            // predated the ones that legitimately ship a pair; the corpus
            // total below is what keeps the whole from shrinking.
            XCTAssertGreaterThanOrEqual(loaded.cases.count, 2, "\(file).json lost cases — check it against the api jest driver")
            XCTAssertTrue(
                loaded.consumers.contains("apps/apple/CrowiKit/Tests/CrowiKitTests/RenderedAstGoldenCorpusTests.swift"),
                "\(file).json no longer lists this test as a consumer — the two-consumer contract drifted"
            )
            total += loaded.cases.count
        }
        XCTAssertGreaterThanOrEqual(total, 55, "the corpus shrank unexpectedly")
    }

    /// The list above must name every fixture on disk.
    ///
    /// A file added upstream and not listed here is read by nobody, and the
    /// suite stays green — so the consumer half of the contract silently stops
    /// covering it. That is what happened to `frontmatter.json` and
    /// `github-alerts.json`: both shipped, neither was asserted, and the gap
    /// was invisible precisely because nothing failed.
    func testEveryCorpusFileIsRegistered() throws {
        let onDisk = try FileManager.default
            .contentsOfDirectory(at: Self.corpusDirectoryURL, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
            .map { $0.deletingPathExtension().lastPathComponent }
        XCTAssertEqual(
            Set(onDisk).subtracting(Self.corpusFiles), [],
            "a corpus fixture exists that this consumer never reads — add it to corpusFiles"
        )
        XCTAssertEqual(
            Set(Self.corpusFiles).subtracting(onDisk), [],
            "corpusFiles names a fixture that is not on disk"
        )
    }

    /// Consumer contract 1: every `expectedEnvelope` decodes strictly, with
    /// zero envelope-level failures and zero information loss.
    func testEveryExpectedEnvelopeDecodesAndRoundTrips() throws {
        var asserted = 0
        for file in Self.corpusFiles {
            for corpusCase in try loadFile(file).cases {
                guard let envelope = corpusCase.expectedEnvelope else { continue }
                guard case .envelope(let document) = RenderedAstEnvelopeDecoder.decode(responseValue: envelope) else {
                    XCTFail("\(file)/\(corpusCase.name): expectedEnvelope did not decode as an envelope")
                    continue
                }
                guard let expectedRoot = envelope["root"] as? [String: Any] else {
                    XCTFail("\(file)/\(corpusCase.name): expectedEnvelope has no root object")
                    continue
                }
                assertDeepEqual(
                    CorpusReencoder.encode(document: document),
                    CorpusReencoder.normalize(expectedRoot),
                    "\(file)/\(corpusCase.name): decoding dropped or altered wire content"
                )
                asserted += 1
            }
        }
        XCTAssertGreaterThanOrEqual(asserted, 10, "the envelope round-trip ended up asserting almost nothing")
    }

    /// Consumer contract 2: the local sanitise-walker mirror over the stored
    /// bare `Root` reproduces the server walker's output — including the
    /// degrade cases (`invalid-shape` → `crowiOpaque`, `definition.url`
    /// scheme violation → `'#'`) and, since Phase 5, the sidecar → typed
    /// node projection (`typed-nodes.json`).
    ///
    /// ONE documented normalization: the server re-sanitizes an SVG diagram
    /// payload (`allowSafeHref: false`) and re-encodes the possibly
    /// re-serialized bytes; the Swift mirror validates the payload but
    /// keeps the bytes verbatim (see `RenderedAstEnvelopeDecoder`'s doc
    /// comment). SVG `crowiDiagram.image.base64` is therefore compared as
    /// "both sides carry a validated payload", not byte-for-byte — every
    /// other field (dimensions, mediaType, kind, alt) and every PNG payload
    /// stays exact.
    func testWalkerMirrorMatchesTheExpectedEnvelope() throws {
        var asserted = 0
        for file in Self.corpusFiles {
            for corpusCase in try loadFile(file).cases {
                guard !Self.serverOnlyProjectionFiles.contains(file) else { continue }
                guard let stored = corpusCase.storedRoot, let envelope = corpusCase.expectedEnvelope else { continue }
                guard case .document(let mirrored) = RenderedAstEnvelopeDecoder.sanitize(stored) else {
                    XCTFail("\(file)/\(corpusCase.name): the walker mirror failed the stored AST at envelope level")
                    continue
                }
                guard case .envelope(let decoded) = RenderedAstEnvelopeDecoder.decode(responseValue: envelope) else {
                    XCTFail("\(file)/\(corpusCase.name): expectedEnvelope did not decode")
                    continue
                }
                assertDeepEqual(
                    CorpusReencoder.normalizeSvgDiagramBytes(CorpusReencoder.encode(document: mirrored)),
                    CorpusReencoder.normalizeSvgDiagramBytes(CorpusReencoder.encode(document: decoded)),
                    "\(file)/\(corpusCase.name): walking the stored AST diverged from the expected envelope"
                )
                asserted += 1
            }
        }
        XCTAssertGreaterThanOrEqual(asserted, 10, "the walker-mirror comparison ended up asserting almost nothing")
    }

    /// Happy-path stored ASTs (cases with `expectedAst` but no envelope)
    /// must walk with zero degrades and zero information loss — a consumer
    /// that opaque-ises valid GFM output over-rejects the contract.
    func testValidStoredAstsWalkWithoutDegrades() throws {
        var asserted = 0
        for file in Self.corpusFiles {
            for corpusCase in try loadFile(file).cases {
                guard corpusCase.expectedEnvelope == nil, let stored = corpusCase.storedRoot else { continue }
                guard case .document(let document) = RenderedAstEnvelopeDecoder.sanitize(stored) else {
                    XCTFail("\(file)/\(corpusCase.name): valid stored AST failed at envelope level")
                    continue
                }
                XCTAssertFalse(
                    Self.containsDegradeNode(document.children),
                    "\(file)/\(corpusCase.name): a valid stored AST produced a degrade node"
                )
                assertDeepEqual(
                    CorpusReencoder.encode(document: document),
                    CorpusReencoder.normalize(stored),
                    "\(file)/\(corpusCase.name): walking dropped or altered valid content"
                )
                asserted += 1
            }
        }
        XCTAssertGreaterThanOrEqual(asserted, 10, "the no-degrade walk ended up asserting almost nothing")
    }

    /// Deep structural equality via `NSDictionary` (NSNumber value equality
    /// absorbs Int/Double bridging differences).
    private func assertDeepEqual(_ actual: [String: Any], _ expected: Any, _ message: String) {
        XCTAssertEqual(actual as NSDictionary, ((expected as? [String: Any]) ?? [:]) as NSDictionary, message)
    }

    private static func containsDegradeNode(_ nodes: [RenderedAstNode]) -> Bool {
        var stack = nodes
        while let node = stack.popLast() {
            switch node.kind {
            case .crowiOpaque:
                return true
            case .crowiPlaceholder(let kind, _, _) where kind == .validationFailed || kind == .envelopeInvalid:
                return true
            default:
                stack.append(contentsOf: node.children)
            }
        }
        return false
    }
}

// MARK: - canonical re-encoder (test-only)

/// Re-encodes a decoded document back into the corpus JSON shape so the
/// suite can compare generically. Emits exactly what the model retains:
/// omitted optionals stay omitted (the expected side's `null` dict entries
/// are normalized away before comparison — see the class doc comment).
enum CorpusReencoder {
    static func encode(document: RenderedAstDocument) -> [String: Any] {
        var out: [String: Any] = ["type": "root"]
        if let data = document.data { out["data"] = encode(data: data) }
        out["children"] = document.children.map { encode(node: $0) }
        return out
    }

    static func encode(node: RenderedAstNode) -> [String: Any] {
        var out: [String: Any] = ["type": node.typeName]
        switch node.kind {
        case .paragraph, .thematicBreak, .blockquote, .strong, .emphasis, .delete, .lineBreak,
            .tableRow, .tableCell, .crowiFigure:
            break
        case .crowiFrontmatter(let entries):
            out["entries"] = entries.map { ["key": $0.key, "value": $0.value] }
        case .heading(let depth):
            out["depth"] = depth
        case .list(let ordered, let start, let spread):
            if let ordered { out["ordered"] = ordered }
            if let start { out["start"] = start }
            if let spread { out["spread"] = spread }
        case .listItem(let checked, let spread):
            if let checked { out["checked"] = checked }
            if let spread { out["spread"] = spread }
        case .html(let value), .text(let value), .inlineCode(let value):
            out["value"] = value
        case .code(let value, let lang, let meta):
            out["value"] = value
            if let lang { out["lang"] = lang }
            if let meta { out["meta"] = meta }
        case .math(let value, let meta), .inlineMath(let value, let meta):
            out["value"] = value
            if let meta { out["meta"] = meta }
        case .link(let url, let title):
            out["url"] = url
            if let title { out["title"] = title }
        case .image(let url, let alt, let title):
            out["url"] = url
            if let alt { out["alt"] = alt }
            if let title { out["title"] = title }
        case .table(let align):
            if let align { out["align"] = align.map { $0.map(\.rawValue) as Any? ?? NSNull() } }
        case .definition(let identifier, let url, let label, let title):
            out["identifier"] = identifier
            out["url"] = url
            if let label { out["label"] = label }
            if let title { out["title"] = title }
        case .footnoteDefinition(let identifier, let label), .footnoteReference(let identifier, let label):
            out["identifier"] = identifier
            if let label { out["label"] = label }
        case .linkReference(let identifier, let referenceType, let label):
            out["identifier"] = identifier
            out["referenceType"] = referenceType.rawValue
            if let label { out["label"] = label }
        case .imageReference(let identifier, let referenceType, let label, let alt):
            out["identifier"] = identifier
            out["referenceType"] = referenceType.rawValue
            if let label { out["label"] = label }
            if let alt { out["alt"] = alt }
        case .crowiDiagram(let kind, let diagramType, let alt, let image):
            out["kind"] = kind.rawValue
            if let diagramType { out["diagramType"] = diagramType }
            out["alt"] = alt
            out["image"] = ["mediaType": image.mediaType, "base64": image.base64, "width": image.width, "height": image.height]
        case .crowiLinkCard(let payload):
            out["url"] = payload.url
            if let title = payload.title { out["title"] = title }
            if let description = payload.description { out["description"] = description }
            if let imageURL = payload.imageURL { out["image"] = ["url": imageURL] }
            if let siteName = payload.siteName { out["siteName"] = siteName }
            if let domain = payload.domain { out["domain"] = domain }
        case .crowiPlaceholder(let kind, let label, let reservation):
            out["kind"] = kind.rawValue
            out["label"] = label
            out["reservation"] = encode(reservation: reservation)
        case .crowiOpaque(let reason, let originalType):
            out["reason"] = reason.rawValue
            if let originalType { out["originalType"] = originalType }
        }
        if let data = node.data { out["data"] = encode(data: data) }
        if RenderedAstEnvelopeDecoder.registry[node.typeName]?.childModel != RenderedAstEnvelopeDecoder.ChildModel.none {
            out["children"] = node.children.map { encode(node: $0) }
        }
        return out
    }

    private static func encode(reservation: RenderedAstReservation) -> [String: Any] {
        switch reservation {
        case .fixed(let widthPx, let heightPx):
            var out: [String: Any] = ["variant": "fixed", "heightPx": heightPx]
            if let widthPx { out["widthPx"] = widthPx }
            return out
        case .aspect(let aspectRatio):
            return ["variant": "aspect", "aspectRatio": aspectRatio]
        case .card(let size):
            return ["variant": "card", "size": size]
        }
    }

    private static func encode(data: RenderedAstNodeData) -> [String: Any] {
        var out: [String: Any] = [:]
        if let hName = data.hName { out["hName"] = hName }
        if !data.hProperties.isEmpty {
            out["hProperties"] = data.hProperties.mapValues { encode(propertyValue: $0) }
        }
        if let hChildren = data.hChildren { out["hChildren"] = hChildren.map { encode(hChild: $0) } }
        if let tokens = data.tokens {
            out["tokens"] = tokens.map { line in line.map { encode(token: $0) } }
        }
        if let renderPending = data.renderPending { out["renderPending"] = renderPending }
        return out
    }

    private static func encode(propertyValue: RenderedAstHPropertyValue) -> Any {
        switch propertyValue {
        case .string(let string): return string
        case .number(let number): return number
        case .bool(let bool): return bool
        case .array(let scalars):
            return scalars.map { scalar -> Any in
                switch scalar {
                case .string(let string): return string
                case .number(let number): return number
                }
            }
        }
    }

    private static func encode(hChild: RenderedAstHChild) -> [String: Any] {
        switch hChild {
        case .raw(let value):
            return ["type": "raw", "value": value]
        case .text(let value):
            return ["type": "text", "value": value]
        case .element(let tagName, let properties, let children):
            var out: [String: Any] = ["type": "element", "tagName": tagName, "children": children.map { encode(hChild: $0) }]
            if let properties { out["properties"] = properties.mapValues { encode(propertyValue: $0) } }
            return out
        }
    }

    private static func encode(token: RenderedAstShikiToken) -> [String: Any] {
        ["content": token.content, "light": encode(style: token.light), "dark": encode(style: token.dark)]
    }

    private static func encode(style: RenderedAstShikiTokenStyle) -> [String: Any] {
        var out: [String: Any] = ["color": style.color]
        if let bgColor = style.bgColor { out["bgColor"] = bgColor }
        if let fontStyle = style.fontStyle { out["fontStyle"] = fontStyle.map(\.rawValue) }
        return out
    }

    /// The walker-mirror comparison's ONE payload normalization (see
    /// `testWalkerMirrorMatchesTheExpectedEnvelope`): a DECODABLE SVG
    /// `crowiDiagram.image.base64` collapses to a fixed marker on both
    /// sides — an undecodable one stays verbatim and fails the comparison.
    static func normalizeSvgDiagramBytes(_ dict: [String: Any]) -> [String: Any] {
        var out = dict
        if out["type"] as? String == "crowiDiagram",
            var image = out["image"] as? [String: Any],
            image["mediaType"] as? String == "image/svg+xml",
            let base64 = image["base64"] as? String,
            Data(base64Encoded: base64) != nil {
            image["base64"] = "<validated-svg-bytes>"
            out["image"] = image
        }
        if let children = out["children"] as? [[String: Any]] {
            out["children"] = children.map { normalizeSvgDiagramBytes($0) }
        }
        return out
    }

    /// The expected-side normalization: drop `null` DICT entries (consumer
    /// maps null → no value), drop empty `data` objects (the walker drops
    /// them), keep positional nulls inside arrays (`table.align`).
    static func normalize(_ value: Any) -> Any {
        if let dict = value as? [String: Any] {
            var out: [String: Any] = [:]
            for (key, entry) in dict {
                if entry is NSNull { continue }
                let normalized = normalize(entry)
                if key == "data", let normalizedDict = normalized as? [String: Any], normalizedDict.isEmpty { continue }
                out[key] = normalized
            }
            return out
        }
        if let array = value as? [Any] {
            return array.map { $0 is NSNull ? NSNull() : normalize($0) }
        }
        return value
    }
}
