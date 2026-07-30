import Foundation

/// RFC-0023 / `feature-rendered-ast-wire-contract` — the Swift mirror of the
/// `renderedAst` v1 wire contract.
///
/// The single source of truth for every value in this enum is
/// `packages/api-contract/src/schemas/rendered-ast.ts`; the Swift side
/// deliberately re-states them (the pnpm/SwiftPM island boundary has no
/// build-time bridge, the `CrowiTheme` stance) and the shared golden corpus
/// (`packages/api/src/renderer/__fixtures__/golden-corpus/*.json`, consumed
/// by `RenderedAstGoldenCorpusTests`) is what turns a drift between the two
/// into a red test instead of a silent divergence.
public enum RenderedAstWireContract {
    /// `X-Crowi-Ast-Version` — the content-negotiation request header
    /// (design doc §9). Sending `1` asks the server for the typed envelope;
    /// an old server ignores it and returns the bare `Root` — which is why
    /// the decoder ALSO detects the response shape independently
    /// (belt-and-suspenders, design doc §9).
    public static let headerName = "X-Crowi-Ast-Version"
    /// `CURRENT_AST_VERSION` — single integer, not semver.
    public static let currentAstVersion = 1
    /// `AST_MAX_TREE_DEPTH` — iterative pre-pass limit, never left to recursion.
    public static let maxTreeDepth = 64
    /// `AST_MAX_HAST_DEPTH` — `data.hChildren` subtree depth limit.
    public static let maxHastDepth = 16
    /// `AST_INPUT_LIMIT_BYTES` — coarse DoS gate on the serialized tree.
    public static let inputLimitBytes = 8 * 1024 * 1024
    /// `AST_MAX_IMAGE_BASE64_CHARS` (≈100KB decoded via the 4/3 expansion).
    public static let maxImageBase64Chars = 140_000
    /// `AST_MAX_VALUE_CHARS` — free-form string value cap (text/code/html values).
    public static let maxValueChars = 200_000
    /// `SINGLE_ENTRY_REJECT_BYTES` — decoded diagram image byte cap (§10 deep validation).
    public static let maxDecodedImageBytes = 100 * 1024
    /// `CrowiImagePayloadSchema.mediaType` allow-list.
    public static let allowedImageMediaTypes: Set<String> = ["image/svg+xml", "image/png"]
    /// `CrowiDimensionSchema` — intrinsic dimensions, closed interval.
    public static let minDimension = 1
    public static let maxDimension = 16_384
}

// MARK: - `data` (hast hints, design doc §4)

/// A bounded `hProperties` value — scalars and scalar arrays only
/// (`HPropertyValueSchema`; nested objects are structurally excluded).
public enum RenderedAstHPropertyValue: Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case array([RenderedAstHPropertyScalar])
}

public enum RenderedAstHPropertyScalar: Equatable, Sendable {
    case string(String)
    case number(Double)
}

/// The bounded hast subset allowed inside `data.hChildren` (`HChildSchema` —
/// e.g. remark-emoji's accessible text child). Carried for fidelity; the
/// renderer reads the owning node's own `value` instead.
public indirect enum RenderedAstHChild: Equatable, Sendable {
    case raw(value: String)
    case text(value: String)
    case element(tagName: String, properties: [String: RenderedAstHPropertyValue]?, children: [RenderedAstHChild])
}

/// The common `data` every node type may optionally carry
/// (`HastHintDataSchema`), plus `code`'s two extra keys (`tokens` — the
/// projected shiki sidecar — and `renderPending`, the dispatch retry marker).
public struct RenderedAstNodeData: Equatable, Sendable {
    public var hName: String?
    public var hProperties: [String: RenderedAstHPropertyValue]
    public var hChildren: [RenderedAstHChild]?
    /// `code` only — lines of dual-theme shiki tokens (`ShikiTokenLinesSchema`).
    public var tokens: [[RenderedAstShikiToken]]?
    /// `code` only — `data.renderPending` (same revision may re-render differently later).
    public var renderPending: Bool?

    public init(
        hName: String? = nil,
        hProperties: [String: RenderedAstHPropertyValue] = [:],
        hChildren: [RenderedAstHChild]? = nil,
        tokens: [[RenderedAstShikiToken]]? = nil,
        renderPending: Bool? = nil
    ) {
        self.hName = hName
        self.hProperties = hProperties
        self.hChildren = hChildren
        self.tokens = tokens
        self.renderPending = renderPending
    }

    public var isEmpty: Bool {
        hName == nil && hProperties.isEmpty && hChildren == nil && tokens == nil && renderPending == nil
    }

    /// A string-valued `hProperties` entry (`id`, `data-crowi-image-*`, …) —
    /// any other value type reads as absent.
    public func hPropertyString(_ key: String) -> String? {
        if case .string(let value)? = hProperties[key] { return value }
        return nil
    }

    /// `className` normalized to a list (the wire allows a string or an array).
    public var classNames: [String] {
        switch hProperties["className"] {
        case .string(let value):
            return value.split(separator: " ").map(String.init)
        case .array(let scalars):
            return scalars.compactMap { if case .string(let s) = $0 { return s } else { return nil } }
        default:
            return []
        }
    }
}

// MARK: - shiki tokens (`ShikiTokenSchema`)

public enum RenderedAstShikiFontStyle: String, Equatable, Sendable, CaseIterable {
    case italic
    case bold
    case underline
    case strikethrough
}

public struct RenderedAstShikiTokenStyle: Equatable, Sendable {
    public var color: String
    public var bgColor: String?
    public var fontStyle: [RenderedAstShikiFontStyle]?

    public init(color: String, bgColor: String? = nil, fontStyle: [RenderedAstShikiFontStyle]? = nil) {
        self.color = color
        self.bgColor = bgColor
        self.fontStyle = fontStyle
    }
}

public struct RenderedAstShikiToken: Equatable, Sendable {
    public var content: String
    public var light: RenderedAstShikiTokenStyle
    public var dark: RenderedAstShikiTokenStyle

    public init(content: String, light: RenderedAstShikiTokenStyle, dark: RenderedAstShikiTokenStyle) {
        self.content = content
        self.light = light
        self.dark = dark
    }
}

// MARK: - typed extension payloads (`Crowi*SidecarSchema`)

public struct RenderedAstImagePayload: Equatable, Sendable {
    public var mediaType: String
    public var base64: String
    public var width: Int
    public var height: Int

    public init(mediaType: String, base64: String, width: Int, height: Int) {
        self.mediaType = mediaType
        self.base64 = base64
        self.width = width
        self.height = height
    }
}

public struct RenderedAstLinkCardPayload: Equatable, Sendable {
    public var url: String
    public var title: String?
    public var description: String?
    public var imageURL: String?
    public var siteName: String?
    public var domain: String?

    public init(url: String, title: String? = nil, description: String? = nil, imageURL: String? = nil, siteName: String? = nil, domain: String? = nil) {
        self.url = url
        self.title = title
        self.description = description
        self.imageURL = imageURL
        self.siteName = siteName
        self.domain = domain
    }
}

/// `CrowiPlaceholderKindSchema` — the 13 kinds. `envelopeInvalid` is the
/// envelope-level collapse the SERVER may send as a normal 1-node envelope;
/// the iOS decoder renders it like any other placeholder (no special case).
public enum RenderedAstPlaceholderKind: String, Equatable, Sendable {
    case errorAuth = "error-auth"
    case errorRateLimit = "error-rate-limit"
    case errorNotFound = "error-not-found"
    case errorNetwork = "error-network"
    case errorTimeout = "error-timeout"
    case errorUnknown = "error-unknown"
    case errorBlocked = "error-blocked"
    case errorBusy = "error-busy"
    case sizeLimitEntry = "size-limit-entry"
    case sizeLimitPage = "size-limit-page"
    case dispatchLimit = "dispatch-limit"
    case validationFailed = "validation-failed"
    case envelopeInvalid = "envelope-invalid"
}

/// `ReservationSchema` — mirror of `@crowi/plugin-api`'s `Reservation` union.
public enum RenderedAstReservation: Equatable, Sendable {
    case fixed(widthPx: Double?, heightPx: Double)
    case aspect(aspectRatio: Double)
    case card(size: String)
}

// MARK: - the node union (design doc §3/§6)

/// One validated v1 wire node. `kind` is the typed per-`type` payload;
/// `data`/`children` are uniform (leaf kinds keep `children` empty — the
/// registry's child model, not the array, is what says whether `children`
/// exists on the wire).
public struct RenderedAstNode: Equatable, Sendable {
    public var kind: Kind
    public var data: RenderedAstNodeData?
    public var children: [RenderedAstNode]

    public init(kind: Kind, data: RenderedAstNodeData? = nil, children: [RenderedAstNode] = []) {
        self.kind = kind
        self.data = data
        self.children = children
    }

    public enum TableAlignment: String, Equatable, Sendable {
        case left, right, center
    }

    public enum ReferenceType: String, Equatable, Sendable {
        case shortcut, collapsed, full
    }

    public enum DiagramKind: String, Equatable, Sendable {
        case mermaid, plantuml
    }

    /// `CrowiOpaqueNodeSchema.reason` — also what the local walker mirror
    /// produces when IT degrades a node (defensive redundancy: the same
    /// three-valued taxonomy on both sides of the wire).
    public enum OpaqueReason: String, Equatable, Sendable {
        case unknownType = "unknown-type"
        case invalidShape = "invalid-shape"
        case invalidPosition = "invalid-position"
    }

    public indirect enum Kind: Equatable, Sendable {
        case paragraph
        case heading(depth: Int)
        case thematicBreak
        case blockquote
        case list(ordered: Bool?, start: Int?, spread: Bool?)
        case listItem(checked: Bool?, spread: Bool?)
        case html(value: String)
        case code(value: String, lang: String?, meta: String?)
        case inlineCode(value: String)
        case math(value: String, meta: String?)
        case inlineMath(value: String, meta: String?)
        case text(value: String)
        case strong
        case emphasis
        case delete
        case lineBreak
        case link(url: String, title: String?)
        case image(url: String, alt: String?, title: String?)
        case table(align: [TableAlignment?]?)
        case tableRow
        case tableCell
        case definition(identifier: String, url: String, label: String?, title: String?)
        case footnoteDefinition(identifier: String, label: String?)
        case footnoteReference(identifier: String, label: String?)
        case linkReference(identifier: String, referenceType: ReferenceType, label: String?)
        case imageReference(identifier: String, referenceType: ReferenceType, label: String?, alt: String?)
        case crowiFigure
        case crowiDiagram(kind: DiagramKind, diagramType: String?, alt: String, image: RenderedAstImagePayload)
        case crowiLinkCard(RenderedAstLinkCardPayload)
        case crowiPlaceholder(kind: RenderedAstPlaceholderKind, label: String, reservation: RenderedAstReservation)
        case crowiOpaque(reason: OpaqueReason, originalType: String?)
    }

    /// The wire `type` string of this node — the discriminator, exposed for
    /// diagnostics and the corpus re-encoder.
    public var typeName: String {
        switch kind {
        case .paragraph: return "paragraph"
        case .heading: return "heading"
        case .thematicBreak: return "thematicBreak"
        case .blockquote: return "blockquote"
        case .list: return "list"
        case .listItem: return "listItem"
        case .html: return "html"
        case .code: return "code"
        case .inlineCode: return "inlineCode"
        case .math: return "math"
        case .inlineMath: return "inlineMath"
        case .text: return "text"
        case .strong: return "strong"
        case .emphasis: return "emphasis"
        case .delete: return "delete"
        case .lineBreak: return "break"
        case .link: return "link"
        case .image: return "image"
        case .table: return "table"
        case .tableRow: return "tableRow"
        case .tableCell: return "tableCell"
        case .definition: return "definition"
        case .footnoteDefinition: return "footnoteDefinition"
        case .footnoteReference: return "footnoteReference"
        case .linkReference: return "linkReference"
        case .imageReference: return "imageReference"
        case .crowiFigure: return "crowiFigure"
        case .crowiDiagram: return "crowiDiagram"
        case .crowiLinkCard: return "crowiLinkCard"
        case .crowiPlaceholder: return "crowiPlaceholder"
        case .crowiOpaque: return "crowiOpaque"
        }
    }
}

/// A resolved GFM `definition` (`[ref]: /docs "Docs"`) — the lookup target
/// `linkReference` / `imageReference` resolve against at render time.
public struct RenderedAstDefinition: Equatable, Sendable {
    public var url: String
    public var title: String?

    public init(url: String, title: String? = nil) {
        self.url = url
        self.title = title
    }
}

/// A successfully decoded v1 envelope's `root` — what `RenderedAstView` renders.
public struct RenderedAstDocument: Equatable, Sendable {
    public var data: RenderedAstNodeData?
    public var children: [RenderedAstNode]

    public init(data: RenderedAstNodeData? = nil, children: [RenderedAstNode]) {
        self.data = data
        self.children = children
    }

    /// Every `definition` in the tree, keyed by identifier (first one wins,
    /// matching CommonMark's duplicate-definition rule).
    public var definitions: [String: RenderedAstDefinition] {
        var out: [String: RenderedAstDefinition] = [:]
        var queue = children
        var index = 0
        while index < queue.count {
            let node = queue[index]
            index += 1
            if case .definition(let identifier, let url, _, let title) = node.kind, out[identifier] == nil {
                out[identifier] = RenderedAstDefinition(url: url, title: title)
            }
            queue.append(contentsOf: node.children)
        }
        return out
    }
}
