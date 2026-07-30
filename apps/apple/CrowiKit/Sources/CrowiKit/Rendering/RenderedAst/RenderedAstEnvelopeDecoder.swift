import Foundation

/// RFC-0023 Phase 4 — the strict `renderedAst` decoder: the Swift mirror of
/// the server's sanitising walker (`packages/api/src/renderer/sanitize-ast.ts`,
/// design doc §5/§7/§8/§10), applied to what the server actually sent.
///
/// Two hard rules from the task's fallback contract:
///
///   1. **Response-side shape detection is independent of the request
///      header** (design doc §9 belt-and-suspenders): an old replica ignores
///      `X-Crowi-Ast-Version` and returns the bare `Root`, so the decoder
///      keys on the VALUE having `astVersion == 1` — anything else falls
///      back to the raw-body MarkdownUI path without ever attempting a typed
///      interpretation.
///   2. **Node-level failure degrades one node; envelope-level failure falls
///      back to the raw body.** A node the walker cannot validate becomes a
///      `crowiOpaque` / `crowiPlaceholder{validation-failed}` node (rendered
///      as a VISIBLE placeholder — never dropped silently, never a crash);
///      depth / byte-limit violations and non-root shapes abandon the typed
///      path entirely and let the raw-body renderer take over (unlike the
///      server, which has no raw-body fallback to offer the web and returns
///      an `envelope-invalid` placeholder envelope instead — when THAT
///      envelope arrives here it decodes as a perfectly normal placeholder
///      node, no special case).
///
/// The walker is a **total function** over already-JSON-parsed values: it
/// never throws and never recurses beyond the iterative pre-pass's depth
/// limit (the pre-pass runs first, so the recursive walk is bounded by
/// `maxTreeDepth`).
///
/// Phase 5 — the walker also mirrors the server-side sidecar → typed-node
/// PROJECTION (`sanitize-ast.ts`'s `tryProject` + the §6 `crowiLinkCard`
/// hoist): the envelope a v1 server sends is already projected, but the
/// mirror is what lets the golden corpus (`typed-nodes.json`) drive the
/// SAME stored-AST inputs through both walkers and diff the outputs. ONE
/// deliberate divergence: the server re-sanitizes an SVG diagram payload
/// (`allowSafeHref: false`) and re-encodes the possibly-rewritten bytes;
/// this mirror validates the payload (canonical base64 / ≤100KB) but keeps
/// the bytes verbatim — byte-mirroring the server's HTML serializer is not
/// worth a second SVG toolchain, and the client-side half of that defense
/// is `RenderedAstSvgRenderer`'s no-external-resource guarantee instead.
/// (`RenderedAstGoldenCorpusTests` normalizes exactly that one field.)
public enum RenderedAstDecodeOutcome: Equatable, Sendable {
    case envelope(RenderedAstDocument)
    case fallbackToRawBody(RenderedAstFallbackReason)
}

public enum RenderedAstFallbackReason: Equatable, Sendable {
    /// The response carried no `renderedAst` value at all.
    case missing
    /// The value has no `astVersion` — a bare `Root` (old server / legacy
    /// branch) or some other untyped shape. Never strictly decoded.
    case noAstVersion
    /// The value declared an `astVersion` this build does not understand.
    case unsupportedVersion(Int)
    /// `astVersion == 1` but the envelope itself failed a limit / shape gate.
    case envelopeInvalid(RenderedAstEnvelopeInvalidReason)
}

public enum RenderedAstEnvelopeInvalidReason: Equatable, Sendable {
    case rootShape
    case treeDepthExceeded
    case hastDepthExceeded
    case inputBytesExceeded
    case unserializable
}

public enum RenderedAstEnvelopeDecoder {
    /// Decode a response's raw `renderedAst` value (as produced by
    /// `JSONSerialization`) into either a typed document or a fallback
    /// decision. `nil` means the field was absent.
    public static func decode(responseValue: Any?) -> RenderedAstDecodeOutcome {
        guard let value = responseValue, !(value is NSNull) else { return .fallbackToRawBody(.missing) }
        guard let dict = record(value) else { return .fallbackToRawBody(.noAstVersion) }
        guard let rawVersion = dict["astVersion"], !(rawVersion is NSNull) else {
            // Bare `Root` (or any other unversioned shape): typed
            // interpretation is never attempted (§9).
            return .fallbackToRawBody(.noAstVersion)
        }
        guard let version = intValue(rawVersion) else { return .fallbackToRawBody(.noAstVersion) }
        guard version == RenderedAstWireContract.currentAstVersion else {
            return .fallbackToRawBody(.unsupportedVersion(version))
        }
        guard let root = dict["root"] else { return .fallbackToRawBody(.envelopeInvalid(.rootShape)) }
        switch sanitize(root) {
        case .document(let document):
            return .envelope(document)
        case .invalid(let reason):
            return .fallbackToRawBody(.envelopeInvalid(reason))
        }
    }

    // MARK: - sanitize (mirror of `sanitizeAst` steps 0–0c + the walker)

    enum SanitizeOutcome: Equatable {
        case document(RenderedAstDocument)
        case invalid(RenderedAstEnvelopeInvalidReason)
    }

    /// The sanitising walk over a root-shaped value — also the entry point
    /// the golden-corpus tests use to mirror the server walker over a STORED
    /// bare `Root` (`storedAst` / `expectedAst` cases).
    static func sanitize(_ value: Any) -> SanitizeOutcome {
        guard let root = record(value), (root["type"] as? String) == "root", root["children"] is [Any] else {
            return .invalid(.rootShape)
        }
        // Coarse input-side DoS gates BEFORE any recursion (§7): serialized
        // byte count first (`JSONSerialization` also rejects pathological
        // object graphs outright), then the iterative depth pre-pass.
        guard JSONSerialization.isValidJSONObject(root), let serialized = try? JSONSerialization.data(withJSONObject: root) else {
            return .invalid(.unserializable)
        }
        guard serialized.count <= RenderedAstWireContract.inputLimitBytes else {
            return .invalid(.inputBytesExceeded)
        }
        if let reason = preflightDepth(root) { return .invalid(reason) }

        let rawChildren = root["children"] as? [Any] ?? []
        let children = sanitizeNodes(rawChildren, parentModel: .flow, chain: false)
        return .document(RenderedAstDocument(data: sanitizeHastData(root["data"]), children: children))
    }

    // MARK: - iterative pre-pass (§7 — explicit stacks, no recursion)

    private static func preflightDepth(_ root: [String: Any]) -> RenderedAstEnvelopeInvalidReason? {
        var stack: [(node: [String: Any], depth: Int)] = [(root, 1)]
        while let item = stack.popLast() {
            if item.depth > RenderedAstWireContract.maxTreeDepth { return .treeDepthExceeded }
            if let data = record(item.node["data"]), let hChildren = data["hChildren"] as? [Any], !hastDepthWithinLimit(hChildren) {
                return .hastDepthExceeded
            }
            if let children = item.node["children"] as? [Any] {
                for child in children {
                    if let childDict = record(child) { stack.append((childDict, item.depth + 1)) }
                }
            }
        }
        return nil
    }

    private static func hastDepthWithinLimit(_ hChildren: [Any]) -> Bool {
        var stack: [(node: Any, depth: Int)] = hChildren.map { ($0, 1) }
        while let item = stack.popLast() {
            if item.depth > RenderedAstWireContract.maxHastDepth { return false }
            guard let node = record(item.node) else { continue }
            if let children = node["children"] as? [Any] {
                for child in children { stack.append((child, item.depth + 1)) }
            }
        }
        return true
    }

    // MARK: - the walker (§5) — closed registry + parent content model

    enum ChildModel: Equatable {
        case flow, phrasing, listItems, tableRows, tableCells, none
    }

    enum Placement: Equatable {
        case flow, phrasing, both, listItems, tableRows, tableCells
    }

    /// `RENDERED_AST_NODE_DEFS` — the closed registry (placement + child model).
    /// Per-type field validation lives in `decodeKind` below.
    static let registry: [String: (placement: Placement, childModel: ChildModel)] = [
        "root": (.flow, .flow),
        "paragraph": (.flow, .phrasing),
        "heading": (.flow, .phrasing),
        "thematicBreak": (.flow, .none),
        "blockquote": (.flow, .flow),
        "list": (.flow, .listItems),
        "listItem": (.listItems, .flow),
        "html": (.both, .none),
        "code": (.flow, .none),
        "inlineCode": (.phrasing, .none),
        "math": (.flow, .none),
        "inlineMath": (.phrasing, .none),
        "text": (.phrasing, .none),
        "strong": (.phrasing, .phrasing),
        "emphasis": (.phrasing, .phrasing),
        "delete": (.phrasing, .phrasing),
        "break": (.phrasing, .none),
        "link": (.phrasing, .phrasing),
        "image": (.phrasing, .none),
        "table": (.flow, .tableRows),
        "tableRow": (.tableRows, .tableCells),
        "tableCell": (.tableCells, .phrasing),
        "definition": (.flow, .none),
        "footnoteDefinition": (.flow, .flow),
        "footnoteReference": (.phrasing, .none),
        "linkReference": (.phrasing, .phrasing),
        "imageReference": (.phrasing, .none),
        "crowiFigure": (.flow, .phrasing),
        "crowiDiagram": (.flow, .none),
        "crowiLinkCard": (.flow, .none),
        "crowiPlaceholder": (.both, .none),
        "crowiOpaque": (.both, .none),
    ]

    private static func placementAllows(_ placement: Placement, in parentModel: ChildModel) -> Bool {
        switch parentModel {
        case .flow: return placement == .flow || placement == .both
        case .phrasing: return placement == .phrasing || placement == .both
        case .listItems: return placement == .listItems
        case .tableRows: return placement == .tableRows
        case .tableCells: return placement == .tableCells
        case .none: return false
        }
    }

    private static func opaque(_ reason: RenderedAstNode.OpaqueReason, originalType: String?) -> RenderedAstNode {
        RenderedAstNode(kind: .crowiOpaque(reason: reason, originalType: originalType))
    }

    /// `VALIDATION_FAILED_LABEL` / `DEFAULT_RESERVATION` mirror (`sanitize-ast.ts`).
    static let validationFailedLabel = "This content could not be displayed."

    private static func validationFailedPlaceholder() -> RenderedAstNode {
        RenderedAstNode(kind: .crowiPlaceholder(
            kind: .validationFailed,
            label: validationFailedLabel,
            reservation: .fixed(widthPx: nil, heightPx: 48)
        ))
    }

    private static func truncate64(_ value: String) -> String {
        value.count > 64 ? String(value.prefix(64)) : value
    }

    private static func sanitizeNodes(_ raw: [Any], parentModel: ChildModel, chain: Bool) -> [RenderedAstNode] {
        raw.flatMap { sanitizeNode($0, parentModel: parentModel, chain: chain) }
    }

    /// `chain` tracks the §6 hoist precondition (mirror of the server
    /// walker): true while every ancestor from the nearest flow node down
    /// is `paragraph` → (`emphasis` | `strong` | `delete` | `link`)*. A
    /// card sidecar in a `heading` / `tableCell` (chain=false) is NOT
    /// projected — the html node stays (visible placeholder).
    private static func childChain(parentType: String, currentChain: Bool) -> Bool {
        if parentType == "paragraph" { return true }
        if parentType == "emphasis" || parentType == "strong" || parentType == "delete" || parentType == "link" {
            return currentChain
        }
        return false
    }

    private static func sanitizeNode(_ raw: Any, parentModel: ChildModel, chain: Bool) -> [RenderedAstNode] {
        guard let node = record(raw), let type = node["type"] as? String else {
            return [opaque(.invalidShape, originalType: nil)]
        }
        // A nested `root` is never valid content.
        if type == "root" { return [opaque(.invalidPosition, originalType: "root")] }
        guard let def = registry[type] else { return [opaque(.unknownType, originalType: truncate64(type))] }

        // §5 step 1b — sidecar → typed-node projection (the server mirror).
        // No / invalid / ambiguous sidecar, or an incompatible position
        // without a hoist: fall through and stay `html` (fail safe).
        if type == "html", let projected = tryProject(node, parentModel: parentModel, chain: chain) {
            return [projected]
        }

        guard placementAllows(def.placement, in: parentModel) else {
            return [opaque(.invalidPosition, originalType: truncate64(type))]
        }

        // crowiFigure structural data requirement (image-attrs contract):
        // `hName` pinned to 'figure', `hProperties` required.
        var figureData: RenderedAstNodeData?
        if type == "crowiFigure" {
            guard
                let data = record(node["data"]),
                (data["hName"] as? String) == "figure",
                data["hProperties"] != nil,
                let hProps = validatedHProperties(data["hProperties"])
            else { return [opaque(.invalidShape, originalType: "crowiFigure")] }
            figureData = RenderedAstNodeData(hName: "figure", hProperties: hProps)
        }

        guard var kind = decodeKind(type: type, node: node) else {
            return [opaque(.invalidShape, originalType: truncate64(type))]
        }

        // §8 URL allow-list + §10 per-type deep validation — the same
        // degrades as the server walker, re-applied locally (the wire is an
        // untrusted transport).
        switch kind {
        case .link(let url, let title):
            if !isAllowedGeneralURL(url) { kind = .link(url: "#", title: title) }
        case .definition(let identifier, let url, let label, let title):
            if !isAllowedGeneralURL(url) { kind = .definition(identifier: identifier, url: "#", label: label, title: title) }
        case .image(let url, _, _):
            if !isAllowedGeneralURL(url) { return [validationFailedPlaceholder()] }
        case .crowiDiagram(_, _, _, let image):
            if !isValidImagePayload(image) { return [validationFailedPlaceholder()] }
        case .crowiLinkCard(let payload):
            guard let validated = validatedCardPayload(payload) else { return [validationFailedPlaceholder()] }
            kind = .crowiLinkCard(validated)
        default:
            break
        }

        let data: RenderedAstNodeData?
        if type == "crowiFigure" {
            data = figureData
        } else if type == "code" {
            data = sanitizeCodeData(node["data"])
        } else {
            data = sanitizeHastData(node["data"])
        }

        var children: [RenderedAstNode] = []
        if def.childModel != .none {
            let rawChildren = node["children"] as? [Any] ?? []
            children = sanitizeNodes(rawChildren, parentModel: def.childModel, chain: childChain(parentType: type, currentChain: chain))
        }

        let out = RenderedAstNode(kind: kind, data: data, children: children)

        // §6 — hoist projected cards out of the paragraph subtree.
        if type == "paragraph", subtreeHasCard(out) {
            return splitParent(out)
        }
        return [out]
    }

    // MARK: - §6 crowiLinkCard hoist (mirror of `splitParent`)

    private static func subtreeHasCard(_ node: RenderedAstNode) -> Bool {
        var stack = [node]
        while let current = stack.popLast() {
            if case .crowiLinkCard = current.kind { return true }
            stack.append(contentsOf: current.children)
        }
        return false
    }

    private static func isSplittableAncestor(_ node: RenderedAstNode) -> Bool {
        switch node.kind {
        case .paragraph, .emphasis, .strong, .delete, .link:
            return true
        default:
            return false
        }
    }

    /// Split `parent` around every `crowiLinkCard` descendant: phrasing
    /// runs on either side re-wrap in a same-kinded copy of the ancestor
    /// chain; empty copies (card at the start / end) are never emitted.
    private static func splitParent(_ parent: RenderedAstNode) -> [RenderedAstNode] {
        var out: [RenderedAstNode] = []
        var acc: [RenderedAstNode] = []
        func flush() {
            if !acc.isEmpty {
                out.append(RenderedAstNode(kind: parent.kind, data: parent.data, children: acc))
                acc = []
            }
        }
        for child in parent.children {
            if case .crowiLinkCard = child.kind {
                flush()
                out.append(child)
                continue
            }
            if isSplittableAncestor(child), subtreeHasCard(child) {
                for part in splitParent(child) {
                    if case .crowiLinkCard = part.kind {
                        flush()
                        out.append(part)
                    } else {
                        acc.append(part)
                    }
                }
                continue
            }
            acc.append(child)
        }
        flush()
        return out
    }

    // MARK: - §5 step 1b projection (mirror of `tryProject` + §10 sidecar schemas)

    private static let sidecarKeys = ["crowiCode", "crowiMath", "crowiDiagram", "crowiLinkCard", "crowiPlaceholder"]

    /// Projects an `html` node carrying EXACTLY ONE valid sidecar into its
    /// typed node (the html `value` string never survives). Returns `nil`
    /// when nothing projects (no/ambiguous/schema-invalid sidecar, or a
    /// position the projection cannot legally occupy) — the html node then
    /// stays as-is. A schema-VALID sidecar whose payload fails the §10 deep
    /// validation degrades to `crowiPlaceholder{validation-failed}`.
    private static func tryProject(_ node: [String: Any], parentModel: ChildModel, chain: Bool) -> RenderedAstNode? {
        guard let data = record(node["data"]) else { return nil }
        let present = sidecarKeys.filter { data[$0] != nil }
        guard present.count == 1, let key = present.first, let payload = data[key] else { return nil }
        // `data.hProperties` (etc.) carry over to the projected node —
        // load-bearing for preview scroll-sync on display math (§10).
        let carried = sanitizeHastData(node["data"])

        switch key {
        case "crowiCode":
            guard
                parentModel == .flow,
                let sidecar = record(payload),
                let value = requiredString(sidecar["value"], max: RenderedAstWireContract.maxValueChars),
                let lang = optionalString(sidecar["lang"], max: 64),
                let tokens = validatedTokenLines(sidecar["tokens"])
            else { return nil }
            var codeData = carried ?? RenderedAstNodeData()
            codeData.tokens = tokens
            return RenderedAstNode(kind: .code(value: value, lang: lang.value, meta: nil), data: codeData)
        case "crowiMath":
            guard
                let sidecar = record(payload),
                let tex = requiredString(sidecar["tex"], max: RenderedAstWireContract.maxValueChars),
                let display = boolValue(sidecar["display"])
            else { return nil }
            if display, parentModel != .flow { return nil }
            if !display, parentModel != .phrasing { return nil }
            return RenderedAstNode(kind: display ? .math(value: tex, meta: nil) : .inlineMath(value: tex, meta: nil), data: carried)
        case "crowiDiagram":
            guard
                parentModel == .flow,
                let sidecar = record(payload),
                let kindString = sidecar["kind"] as? String,
                let diagramKind = RenderedAstNode.DiagramKind(rawValue: kindString),
                let diagramType = optionalString(sidecar["diagramType"], max: 32),
                let alt = requiredString(sidecar["alt"], max: 256),
                let image = imagePayload(sidecar["image"])
            else { return nil }
            // Deep validation (schema-valid but bad payload) → visible
            // placeholder, mirroring the server. NOTE: the server also
            // re-sanitizes + possibly re-encodes an SVG payload here; this
            // mirror keeps the bytes verbatim (see the type doc comment).
            guard isValidImagePayload(image) else { return validationFailedPlaceholder() }
            return RenderedAstNode(
                kind: .crowiDiagram(kind: diagramKind, diagramType: diagramType.value, alt: alt, image: image),
                data: carried
            )
        case "crowiLinkCard":
            let positionOk = parentModel == .flow || (parentModel == .phrasing && chain)
            guard
                positionOk,
                let sidecar = record(payload),
                let url = requiredString(sidecar["url"], max: 4096),
                let title = optionalString(sidecar["title"], max: 512),
                let description = optionalString(sidecar["description"], max: 2048),
                let siteName = optionalString(sidecar["siteName"], max: 256),
                let domain = optionalString(sidecar["domain"], max: 256)
            else { return nil }
            var imageURL: String?
            if let rawImage = sidecar["image"] {
                guard let imageDict = record(rawImage), let candidate = requiredString(imageDict["url"], max: 4096) else {
                    return nil
                }
                imageURL = candidate
            }
            let payload = RenderedAstLinkCardPayload(
                url: url,
                title: title.value,
                description: description.value,
                imageURL: imageURL,
                siteName: siteName.value,
                domain: domain.value
            )
            guard let validated = validatedCardPayload(payload) else { return validationFailedPlaceholder() }
            return RenderedAstNode(kind: .crowiLinkCard(validated), data: carried)
        case "crowiPlaceholder":
            guard
                let sidecar = record(payload),
                let kindString = sidecar["kind"] as? String,
                let placeholderKind = RenderedAstPlaceholderKind(rawValue: kindString),
                let label = requiredString(sidecar["label"], max: 512),
                let reservation = reservation(sidecar["reservation"])
            else { return nil }
            return RenderedAstNode(
                kind: .crowiPlaceholder(kind: placeholderKind, label: label, reservation: reservation),
                data: carried
            )
        default:
            return nil
        }
    }

    // MARK: - per-type field validation (mirror of the zod field schemas)

    // swiftlint:disable:next cyclomatic_complexity
    private static func decodeKind(type: String, node: [String: Any]) -> RenderedAstNode.Kind? {
        switch type {
        case "paragraph": return .paragraph
        case "thematicBreak": return .thematicBreak
        case "blockquote": return .blockquote
        case "strong": return .strong
        case "emphasis": return .emphasis
        case "delete": return .delete
        case "break": return .lineBreak
        case "tableRow": return .tableRow
        case "tableCell": return .tableCell
        case "crowiFigure": return .crowiFigure
        case "heading":
            guard let depth = intValue(node["depth"]), (1...6).contains(depth) else { return nil }
            return .heading(depth: depth)
        case "text":
            guard let value = requiredString(node["value"], max: RenderedAstWireContract.maxValueChars) else { return nil }
            return .text(value: value)
        case "html":
            guard let value = requiredString(node["value"], max: RenderedAstWireContract.maxValueChars) else { return nil }
            return .html(value: value)
        case "inlineCode":
            guard let value = requiredString(node["value"], max: RenderedAstWireContract.maxValueChars) else { return nil }
            return .inlineCode(value: value)
        case "code":
            guard
                let value = requiredString(node["value"], max: RenderedAstWireContract.maxValueChars),
                let lang = nullableString(node["lang"], max: 64),
                let meta = nullableString(node["meta"], max: 1024)
            else { return nil }
            return .code(value: value, lang: lang.value, meta: meta.value)
        case "math", "inlineMath":
            guard
                let value = requiredString(node["value"], max: RenderedAstWireContract.maxValueChars),
                let meta = nullableString(node["meta"], max: 1024)
            else { return nil }
            return type == "math" ? .math(value: value, meta: meta.value) : .inlineMath(value: value, meta: meta.value)
        case "list":
            guard
                let ordered = nullableBool(node["ordered"]),
                let start = nullableInt(node["start"]),
                let spread = nullableBool(node["spread"])
            else { return nil }
            return .list(ordered: ordered.value, start: start.value, spread: spread.value)
        case "listItem":
            guard let checked = nullableBool(node["checked"]), let spread = nullableBool(node["spread"]) else { return nil }
            return .listItem(checked: checked.value, spread: spread.value)
        case "link":
            guard
                let url = requiredString(node["url"], max: 4096),
                let title = nullableString(node["title"], max: 512)
            else { return nil }
            return .link(url: url, title: title.value)
        case "image":
            guard
                let url = requiredString(node["url"], max: 4096),
                let alt = nullableString(node["alt"], max: 1024),
                let title = nullableString(node["title"], max: 512)
            else { return nil }
            return .image(url: url, alt: alt.value, title: title.value)
        case "table":
            guard let align = tableAlign(node["align"]) else { return nil }
            return .table(align: align.value)
        case "definition":
            guard
                let identifier = requiredString(node["identifier"], max: 256),
                let url = requiredString(node["url"], max: 4096),
                let label = optionalString(node["label"], max: 256),
                let title = nullableString(node["title"], max: 512)
            else { return nil }
            return .definition(identifier: identifier, url: url, label: label.value, title: title.value)
        case "footnoteDefinition", "footnoteReference":
            guard
                let identifier = requiredString(node["identifier"], max: 256),
                let label = optionalString(node["label"], max: 256)
            else { return nil }
            return type == "footnoteDefinition"
                ? .footnoteDefinition(identifier: identifier, label: label.value)
                : .footnoteReference(identifier: identifier, label: label.value)
        case "linkReference":
            guard
                let identifier = requiredString(node["identifier"], max: 256),
                let referenceType = referenceType(node["referenceType"]),
                let label = optionalString(node["label"], max: 256)
            else { return nil }
            return .linkReference(identifier: identifier, referenceType: referenceType, label: label.value)
        case "imageReference":
            guard
                let identifier = requiredString(node["identifier"], max: 256),
                let referenceType = referenceType(node["referenceType"]),
                let label = optionalString(node["label"], max: 256),
                let alt = nullableString(node["alt"], max: 1024)
            else { return nil }
            return .imageReference(identifier: identifier, referenceType: referenceType, label: label.value, alt: alt.value)
        case "crowiDiagram":
            guard
                let kindString = requiredString(node["kind"], max: 32),
                let diagramKind = RenderedAstNode.DiagramKind(rawValue: kindString),
                let diagramType = optionalString(node["diagramType"], max: 32),
                let alt = requiredString(node["alt"], max: 256),
                let image = imagePayload(node["image"])
            else { return nil }
            return .crowiDiagram(kind: diagramKind, diagramType: diagramType.value, alt: alt, image: image)
        case "crowiLinkCard":
            guard
                let url = requiredString(node["url"], max: 4096),
                let title = optionalString(node["title"], max: 512),
                let description = optionalString(node["description"], max: 2048),
                let siteName = optionalString(node["siteName"], max: 256),
                let domain = optionalString(node["domain"], max: 256)
            else { return nil }
            var imageURL: String?
            if let rawImage = node["image"], !(rawImage is NSNull) {
                guard let imageDict = record(rawImage), let url = requiredString(imageDict["url"], max: 4096) else { return nil }
                imageURL = url
            }
            return .crowiLinkCard(RenderedAstLinkCardPayload(
                url: url,
                title: title.value,
                description: description.value,
                imageURL: imageURL,
                siteName: siteName.value,
                domain: domain.value
            ))
        case "crowiPlaceholder":
            guard
                let kindString = requiredString(node["kind"], max: 64),
                let placeholderKind = RenderedAstPlaceholderKind(rawValue: kindString),
                let label = requiredString(node["label"], max: 512),
                let reservation = reservation(node["reservation"])
            else { return nil }
            return .crowiPlaceholder(kind: placeholderKind, label: label, reservation: reservation)
        case "crowiOpaque":
            guard
                let reasonString = requiredString(node["reason"], max: 64),
                let reason = RenderedAstNode.OpaqueReason(rawValue: reasonString),
                let originalType = optionalString(node["originalType"], max: 64)
            else { return nil }
            return .crowiOpaque(reason: reason, originalType: originalType.value)
        default:
            return nil
        }
    }

    private static func referenceType(_ raw: Any?) -> RenderedAstNode.ReferenceType? {
        guard let string = raw as? String else { return nil }
        return RenderedAstNode.ReferenceType(rawValue: string)
    }

    /// `table.align`: `z.array(z.enum(...).nullable()).max(256).nullable().optional()`.
    private static func tableAlign(_ raw: Any?) -> (value: [RenderedAstNode.TableAlignment?]?, ok: Bool)? {
        guard let raw, !(raw is NSNull) else { return (nil, true) }
        guard let array = raw as? [Any], array.count <= 256 else { return nil }
        var out: [RenderedAstNode.TableAlignment?] = []
        for entry in array {
            if entry is NSNull {
                out.append(nil)
            } else if let string = entry as? String, let alignment = RenderedAstNode.TableAlignment(rawValue: string) {
                out.append(alignment)
            } else {
                return nil
            }
        }
        return (out, true)
    }

    private static func imagePayload(_ raw: Any?) -> RenderedAstImagePayload? {
        guard
            let dict = record(raw),
            let mediaType = dict["mediaType"] as? String,
            RenderedAstWireContract.allowedImageMediaTypes.contains(mediaType),
            let base64 = requiredString(dict["base64"], max: RenderedAstWireContract.maxImageBase64Chars),
            let width = intValue(dict["width"]),
            let height = intValue(dict["height"]),
            (RenderedAstWireContract.minDimension...RenderedAstWireContract.maxDimension).contains(width),
            (RenderedAstWireContract.minDimension...RenderedAstWireContract.maxDimension).contains(height)
        else { return nil }
        return RenderedAstImagePayload(mediaType: mediaType, base64: base64, width: width, height: height)
    }

    private static func reservation(_ raw: Any?) -> RenderedAstReservation? {
        guard let dict = record(raw), let variant = dict["variant"] as? String else { return nil }
        switch variant {
        case "fixed":
            guard let heightPx = doubleValue(dict["heightPx"]) else { return nil }
            var widthPx: Double?
            if let rawWidth = dict["widthPx"], !(rawWidth is NSNull) {
                guard let width = doubleValue(rawWidth) else { return nil }
                widthPx = width
            }
            return .fixed(widthPx: widthPx, heightPx: heightPx)
        case "aspect":
            guard let aspectRatio = doubleValue(dict["aspectRatio"]) else { return nil }
            return .aspect(aspectRatio: aspectRatio)
        case "card":
            guard let size = dict["size"] as? String, ["small", "medium", "large"].contains(size) else { return nil }
            return .card(size: size)
        default:
            return nil
        }
    }

    // MARK: - §10 deep image validation (v1 trust boundary)

    /// Strict base64 decode + decoded-size cap + PNG signature check —
    /// mirror of `validateImagePayload`. The server's second SVG
    /// sanitisation pass is NOT mirrored here: Phase 4 renders diagrams as
    /// placeholders (nothing ever decodes the SVG), and Phase 5's SVG
    /// renderer selection is required to disable resource loading outright
    /// (parent spec §8), which is the client-side half of that defense.
    static func isValidImagePayload(_ image: RenderedAstImagePayload) -> Bool {
        guard isCanonicalBase64(image.base64) else { return false }
        guard let decoded = Data(base64Encoded: image.base64) else { return false }
        guard decoded.count <= RenderedAstWireContract.maxDecodedImageBytes else { return false }
        if image.mediaType == "image/png" {
            let signature: [UInt8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
            guard decoded.count >= signature.count, Array(decoded.prefix(signature.count)) == signature else { return false }
        }
        return true
    }

    /// Canonical base64: allowed alphabet, length % 4 == 0, padding only at
    /// the very end (mirror of `CANONICAL_BASE64_RE`).
    static func isCanonicalBase64(_ string: String) -> Bool {
        let bytes = Array(string.utf8)
        guard bytes.count % 4 == 0 else { return false }
        var paddingCount = 0
        for (index, byte) in bytes.enumerated() {
            switch byte {
            case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"),
                UInt8(ascii: "0")...UInt8(ascii: "9"), UInt8(ascii: "+"), UInt8(ascii: "/"):
                if paddingCount > 0 { return false } // padding must be terminal
            case UInt8(ascii: "="):
                guard index >= bytes.count - 2 else { return false }
                paddingCount += 1
            default:
                return false
            }
        }
        return paddingCount <= 2
    }

    // MARK: - §8 URL allow-list

    /// General rule: http(s) / mailto / relative / fragment-only. `mailto`
    /// passes the WIRE rule (it is a legal `link.url`), but stays inert at
    /// TAP time — iOS's §6.2 `SchemeAllowlist` (http/https/relative only,
    /// OQ-9 pin) is what every actual navigation goes through.
    static func isAllowedGeneralURL(_ url: String) -> Bool {
        if url.isEmpty || url.hasPrefix("#") { return true }
        if url.hasPrefix("//") { return false } // protocol-relative
        guard let scheme = leadingScheme(of: url) else { return true } // relative
        return scheme == "http" || scheme == "https" || scheme == "mailto"
    }

    /// Card override (§8): absolute http(s) only.
    static func isHTTPOnlyURL(_ url: String) -> Bool {
        guard let scheme = leadingScheme(of: url) else { return false }
        return scheme == "http" || scheme == "https"
    }

    /// The §8 card override in ONE place (mirror of `validateCardFields`),
    /// applied both to envelope-decoded card nodes and to sidecar
    /// projections: a non-http(s) `url` degrades the whole card (`nil` →
    /// validation-failed placeholder); a non-http(s) image URL just drops
    /// the field (image-less card).
    private static func validatedCardPayload(_ payload: RenderedAstLinkCardPayload) -> RenderedAstLinkCardPayload? {
        guard isHTTPOnlyURL(payload.url) else { return nil }
        var out = payload
        if let imageURL = out.imageURL, !isHTTPOnlyURL(imageURL) { out.imageURL = nil }
        return out
    }

    /// The `^([a-zA-Z][a-zA-Z0-9+.-]*):` prefix, lowercased — or nil.
    private static func leadingScheme(of url: String) -> String? {
        var scheme = ""
        for (index, character) in url.enumerated() {
            if character == ":" {
                return index > 0 ? scheme.lowercased() : nil
            }
            if index == 0 {
                guard character.isASCII, character.isLetter else { return nil }
            } else {
                guard character.isASCII, character.isLetter || character.isNumber || character == "+" || character == "." || character == "-" else {
                    return nil
                }
            }
            scheme.append(character)
        }
        return nil
    }

    // MARK: - `data` sanitisation (§4 — bounded per-key; failures drop the key, never the node)

    static func sanitizeHastData(_ raw: Any?) -> RenderedAstNodeData? {
        guard let data = record(raw) else { return nil }
        var out = RenderedAstNodeData()
        if let rawName = data["hName"], let name = rawName as? String, isValidHName(name) {
            out.hName = name
        }
        if data["hProperties"] != nil, let properties = validatedHProperties(data["hProperties"]) {
            out.hProperties = properties
        }
        if data["hChildren"] != nil, let children = validatedHChildren(data["hChildren"]) {
            out.hChildren = children
        }
        return out.isEmpty ? nil : out
    }

    /// `code` additionally keeps `renderPending` (retry marker) and the
    /// projected `tokens` (the ONLY cross-client representation of syntax
    /// highlighting — the server walker never sees tokens on its input, but
    /// the v1 envelope's projected `code` nodes carry them, mirroring
    /// `CodeDataSchema`). Invalid tokens drop the key (plain-code degrade).
    static func sanitizeCodeData(_ raw: Any?) -> RenderedAstNodeData? {
        var out = sanitizeHastData(raw) ?? RenderedAstNodeData()
        if let data = record(raw) {
            if let pending = data["renderPending"], let bool = boolValue(pending) { out.renderPending = bool }
            if data["tokens"] != nil, let tokens = validatedTokenLines(data["tokens"]) { out.tokens = tokens }
        }
        return out.isEmpty ? nil : out
    }

    static func isValidHName(_ name: String) -> Bool {
        guard name.utf16.count <= 32, let first = name.first, first.isASCII, first.isLetter else { return false }
        return name.dropFirst().allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
    }

    /// Mirror of `HPropertiesSchema` — the whole map validates or the whole
    /// map is dropped (zod object parse semantics).
    static func validatedHProperties(_ raw: Any?) -> [String: RenderedAstHPropertyValue]? {
        guard let dict = record(raw) else { return nil }
        var out: [String: RenderedAstHPropertyValue] = [:]
        for (key, rawValue) in dict {
            guard let value = validatedHProperty(key: key, rawValue: rawValue) else { return nil }
            out[key] = value
        }
        return out
    }

    private static func validatedHProperty(key: String, rawValue: Any) -> RenderedAstHPropertyValue? {
        if rawValue is NSNull { return nil }
        switch key {
        case "id":
            guard let string = boundedString(rawValue, max: 256) else { return nil }
            return .string(string)
        case "className":
            if let string = boundedString(rawValue, max: 4096) { return .string(string) }
            guard let array = rawValue as? [Any], array.count <= 64 else { return nil }
            var scalars: [RenderedAstHPropertyScalar] = []
            for entry in array {
                guard let string = boundedString(entry, max: 256) else { return nil }
                scalars.append(.string(string))
            }
            return .array(scalars)
        case "role":
            guard let string = boundedString(rawValue, max: 64) else { return nil }
            return .string(string)
        case "ariaLabel":
            guard let string = boundedString(rawValue, max: 256) else { return nil }
            return .string(string)
        case "data-source-line":
            if let string = boundedString(rawValue, max: 32) { return .string(string) }
            if let number = doubleValue(rawValue) { return .number(number) }
            return nil
        case "data-crowi-image-align", "data-crowi-image-float", "data-crowi-image-width", "data-crowi-image-height":
            guard let string = boundedString(rawValue, max: 16) else { return nil }
            return .string(string)
        default:
            return catchallHProperty(rawValue)
        }
    }

    /// `HPropertyValueSchema` — string ≤4096 | number | boolean | scalar array ≤64.
    private static func catchallHProperty(_ rawValue: Any) -> RenderedAstHPropertyValue? {
        if let bool = boolValue(rawValue) { return .bool(bool) }
        if let string = boundedString(rawValue, max: 4096) { return .string(string) }
        if let number = doubleValue(rawValue) { return .number(number) }
        if let array = rawValue as? [Any], array.count <= 64 {
            var scalars: [RenderedAstHPropertyScalar] = []
            for entry in array {
                if let string = boundedString(entry, max: 4096) {
                    scalars.append(.string(string))
                } else if let number = doubleValue(entry) {
                    scalars.append(.number(number))
                } else {
                    return nil
                }
            }
            return .array(scalars)
        }
        return nil
    }

    /// Mirror of `HChildrenSchema` (`.max(256)` + recursive `HChildSchema`).
    static func validatedHChildren(_ raw: Any?) -> [RenderedAstHChild]? {
        guard let array = raw as? [Any], array.count <= 256 else { return nil }
        var out: [RenderedAstHChild] = []
        for entry in array {
            guard let child = validatedHChild(entry) else { return nil }
            out.append(child)
        }
        return out
    }

    private static func validatedHChild(_ raw: Any) -> RenderedAstHChild? {
        guard let dict = record(raw), let type = dict["type"] as? String else { return nil }
        switch type {
        case "raw", "text":
            guard let value = requiredString(dict["value"], max: RenderedAstWireContract.maxValueChars) else { return nil }
            return type == "raw" ? .raw(value: value) : .text(value: value)
        case "element":
            guard let tagName = dict["tagName"] as? String, isValidHName(tagName) else { return nil }
            var properties: [String: RenderedAstHPropertyValue]?
            if let rawProperties = dict["properties"], !(rawProperties is NSNull) {
                guard let validated = validatedHProperties(rawProperties) else { return nil }
                properties = validated
            }
            guard let rawChildren = dict["children"] as? [Any] else { return nil }
            var children: [RenderedAstHChild] = []
            for entry in rawChildren {
                guard let child = validatedHChild(entry) else { return nil }
                children.append(child)
            }
            return .element(tagName: tagName, properties: properties, children: children)
        default:
            return nil
        }
    }

    /// Mirror of `ShikiTokenLinesSchema`.
    static func validatedTokenLines(_ raw: Any?) -> [[RenderedAstShikiToken]]? {
        guard let lines = raw as? [Any], lines.count <= 20_000 else { return nil }
        var out: [[RenderedAstShikiToken]] = []
        for rawLine in lines {
            guard let line = rawLine as? [Any] else { return nil }
            var tokens: [RenderedAstShikiToken] = []
            for rawToken in line {
                guard
                    let dict = record(rawToken),
                    let content = requiredString(dict["content"], max: 4096),
                    let light = validatedTokenStyle(dict["light"]),
                    let dark = validatedTokenStyle(dict["dark"])
                else { return nil }
                tokens.append(RenderedAstShikiToken(content: content, light: light, dark: dark))
            }
            out.append(tokens)
        }
        return out
    }

    private static func validatedTokenStyle(_ raw: Any?) -> RenderedAstShikiTokenStyle? {
        guard let dict = record(raw), let color = requiredString(dict["color"], max: 32) else { return nil }
        var style = RenderedAstShikiTokenStyle(color: color)
        if let rawBg = dict["bgColor"], !(rawBg is NSNull) {
            guard let bg = boundedString(rawBg, max: 32) else { return nil }
            style.bgColor = bg
        }
        if let rawFontStyle = dict["fontStyle"], !(rawFontStyle is NSNull) {
            guard let array = rawFontStyle as? [Any], array.count <= 4 else { return nil }
            var flags: [RenderedAstShikiFontStyle] = []
            for entry in array {
                guard let string = entry as? String, let flag = RenderedAstShikiFontStyle(rawValue: string) else { return nil }
                flags.append(flag)
            }
            style.fontStyle = flags
        }
        return style
    }

    // MARK: - JSON value coercion helpers

    private static func record(_ value: Any?) -> [String: Any]? {
        value as? [String: Any]
    }

    /// A required string field with a UTF-16 length cap (zod `.max` counts
    /// JS string length, i.e. UTF-16 code units).
    private static func requiredString(_ value: Any?, max: Int) -> String? {
        boundedString(value, max: max)
    }

    private static func boundedString(_ value: Any?, max: Int) -> String? {
        guard let string = value as? String, string.utf16.count <= max else { return nil }
        return string
    }

    /// `z.string().max(n).optional()` — absent ok, null FAILS.
    private static func optionalString(_ value: Any?, max: Int) -> (value: String?, ok: Bool)? {
        guard let value else { return (nil, true) }
        if value is NSNull { return nil }
        guard let string = boundedString(value, max: max) else { return nil }
        return (string, true)
    }

    /// `z.string().max(n).nullable().optional()` — absent and null both read as nil.
    private static func nullableString(_ value: Any?, max: Int) -> (value: String?, ok: Bool)? {
        guard let value, !(value is NSNull) else { return (nil, true) }
        guard let string = boundedString(value, max: max) else { return nil }
        return (string, true)
    }

    private static func nullableBool(_ value: Any?) -> (value: Bool?, ok: Bool)? {
        guard let value, !(value is NSNull) else { return (nil, true) }
        guard let bool = boolValue(value) else { return nil }
        return (bool, true)
    }

    private static func nullableInt(_ value: Any?) -> (value: Int?, ok: Bool)? {
        guard let value, !(value is NSNull) else { return (nil, true) }
        guard let int = intValue(value) else { return nil }
        return (int, true)
    }

    /// A JSON boolean (never a 0/1 number — `CFBoolean` distinguishes them).
    private static func boolValue(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }

    /// A JSON number with an exact integral value (`z.number().int()`).
    private static func intValue(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        return Int(exactly: number.doubleValue)
    }

    private static func doubleValue(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        return number.doubleValue
    }
}
