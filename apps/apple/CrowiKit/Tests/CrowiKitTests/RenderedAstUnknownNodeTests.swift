import XCTest

@testable import CrowiKit

/// What this build does with a node type a NEWER server invented.
///
/// The registry is closed and only ever grows, so an unknown type always
/// means the server has moved on. The question is only what it costs the
/// reader: the wrapper's decoration, or everything inside it.
final class RenderedAstUnknownNodeTests: XCTestCase {
    private func decode(_ json: String) throws -> RenderedAstDocument {
        let outcome = RenderedAstEnvelopeDecoder.decode(responseValue: try JSONSerialization.jsonObject(with: Data(json.utf8)))
        guard case .envelope(let document) = outcome else {
            throw XCTSkip("expected an envelope, got \(outcome)")
        }
        return document
    }

    func testAnUnknownWrapperKeepsItsContents() throws {
        // The shape `crowiAlert` would have had: prose inside a node this
        // build has never heard of.
        let document = try decode("""
        {"astVersion":1,"root":{"type":"root","children":[
          {"type":"crowiSomethingNew","variant":"note","children":[
            {"type":"paragraph","children":[{"type":"text","value":"the body"}]}
          ]}
        ]}}
        """)
        XCTAssertEqual(document.children.count, 1)
        XCTAssertEqual(document.children.first?.kind, .paragraph)
        XCTAssertEqual(document.children.first?.children.map(\.kind), [.text(value: "the body")])
    }

    func testAnUnknownLeafIsStillAPlaceholder() throws {
        // Nothing to stand up in its place, and a silent drop is a contract
        // violation.
        let document = try decode("""
        {"astVersion":1,"root":{"type":"root","children":[
          {"type":"crowiSomethingNew","payload":{"a":1}}
        ]}}
        """)
        XCTAssertEqual(document.children.first?.kind, .crowiOpaque(reason: .unknownType, originalType: "crowiSomethingNew"))
    }

    func testAnEmptyChildrenArrayIsALeaf() throws {
        let document = try decode("""
        {"astVersion":1,"root":{"type":"root","children":[
          {"type":"crowiSomethingNew","children":[]}
        ]}}
        """)
        XCTAssertEqual(document.children.first?.kind, .crowiOpaque(reason: .unknownType, originalType: "crowiSomethingNew"))
    }

    func testUnwrappedChildrenAreStillPlacementChecked() throws {
        // A flow child smuggled into a phrasing position must degrade exactly
        // as it would have without the wrapper — the unknown node buys its
        // contents no trust.
        let document = try decode("""
        {"astVersion":1,"root":{"type":"root","children":[
          {"type":"paragraph","children":[
            {"type":"crowiSomethingNew","children":[
              {"type":"table","children":[]}
            ]}
          ]}
        ]}}
        """)
        let child = try XCTUnwrap(document.children.first?.children.first)
        XCTAssertEqual(child.kind, .crowiOpaque(reason: .invalidPosition, originalType: "table"))
    }

    func testAnUnknownWrapperInsideAListDoesNotBreakTheList() throws {
        // `listItems` only accepts `listItem`; unwrapping a paragraph into
        // that slot must degrade rather than produce a malformed list.
        let document = try decode("""
        {"astVersion":1,"root":{"type":"root","children":[
          {"type":"list","children":[
            {"type":"crowiSomethingNew","children":[
              {"type":"paragraph","children":[{"type":"text","value":"x"}]}
            ]}
          ]}
        ]}}
        """)
        let item = try XCTUnwrap(document.children.first?.children.first)
        XCTAssertEqual(item.kind, .crowiOpaque(reason: .invalidPosition, originalType: "paragraph"))
    }

    func testNestedUnknownWrappersUnwrapAllTheWayDown() throws {
        let document = try decode("""
        {"astVersion":1,"root":{"type":"root","children":[
          {"type":"crowiOuter","children":[
            {"type":"crowiInner","children":[
              {"type":"paragraph","children":[{"type":"text","value":"deep"}]}
            ]}
          ]}
        ]}}
        """)
        XCTAssertEqual(document.children.first?.kind, .paragraph)
        XCTAssertEqual(document.children.first?.children.map(\.kind), [.text(value: "deep")])
    }

    func testAThirdPartyPluginNodeStaysOpaque() throws {
        // The registry legislates `x-<plugin>-<type>`: opaque BY DESIGN, and
        // the server opaque-ises them before sending. Unwrapping would stop
        // this walker mirroring `sanitizeAst` — the property the shared
        // golden corpus exists to guarantee — and would surface content the
        // server withheld.
        let document = try decode("""
        {"astVersion":1,"root":{"type":"root","children":[
          {"type":"x-plugin-callout","children":[
            {"type":"paragraph","children":[{"type":"text","value":"withheld"}]}
          ]}
        ]}}
        """)
        XCTAssertEqual(document.children.first?.kind, .crowiOpaque(reason: .unknownType, originalType: "x-plugin-callout"))
        XCTAssertTrue(document.children.first?.children.isEmpty == true)
    }

    func testTheUnknownTypePlaceholderSaysTheAppIsBehind() {
        // "This content can't be displayed" reads as broken content. It is
        // not: the reader needs an app update, and that is actionable.
        XCTAssertNotEqual(RenderedAstPlaceholderCopy.unknownTypeBlock, RenderedAstPlaceholderCopy.blockUnavailable)
    }
}
