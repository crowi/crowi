import XCTest

@testable import CrowiKit

/// `crowiFrontmatter` is a v1 registry entry, so an app that does not know it
/// draws "This content can't be displayed in the app." where the document's
/// own metadata should be — which is what happened on the first server that
/// shipped it.
final class RenderedAstFrontmatterTests: XCTestCase {
    private func decodeFirstChild(_ entriesJSON: String) throws -> RenderedAstNode {
        let envelope = """
        {"astVersion":1,"root":{"type":"root","children":[
          {"type":"crowiFrontmatter","entries":\(entriesJSON)}
        ]}}
        """
        let outcome = RenderedAstEnvelopeDecoder.decode(responseValue: try JSONSerialization.jsonObject(with: Data(envelope.utf8)))
        guard case .envelope(let document) = outcome else {
            return XCTFail("expected an envelope, got \(outcome)") as! RenderedAstNode
        }
        return try XCTUnwrap(document.children.first)
    }

    func testEntriesSurviveAsLiteralText() throws {
        let node = try decodeFirstChild("""
        [{"key":"note","value":"*starred* と [bracketed]"},{"key":"status","value":"approved"}]
        """)
        XCTAssertEqual(
            node.kind,
            .crowiFrontmatter(entries: [
                RenderedAstFrontmatterEntry(key: "note", value: "*starred* と [bracketed]"),
                RenderedAstFrontmatterEntry(key: "status", value: "approved"),
            ]),
            "values are scanned, never parsed — an asterisk in a value is an asterisk"
        )
    }

    func testAnEmptyValueIsKept() throws {
        // `tags:` with its list on the following lines scans to an empty
        // value; dropping the row would lose the key.
        let node = try decodeFirstChild(#"[{"key":"tags","value":""}]"#)
        XCTAssertEqual(node.kind, .crowiFrontmatter(entries: [RenderedAstFrontmatterEntry(key: "tags", value: "")]))
    }

    func testAnEnvelopeBreakingTheContractsLimitsIsOpaqueRatherThanTrusted() throws {
        // The api-side scanner never emits these, so they mean a malformed
        // envelope. `utf16` counting, matching zod's `.max()`.
        let overLongValue = String(repeating: "a", count: 301)
        let overLongKey = String(repeating: "k", count: 101)
        let tooManyEntries = (0..<51).map { #"{"key":"k\#($0)","value":"v"}"# }.joined(separator: ",")

        for json in [
            #"[{"key":"k","value":"\#(overLongValue)"}]"#,
            #"[{"key":"\#(overLongKey)","value":"v"}]"#,
            "[\(tooManyEntries)]",
            #"[{"key":"k"}]"#,
        ] {
            let node = try decodeFirstChild(json)
            guard case .crowiOpaque(let reason, _) = node.kind else {
                return XCTFail("expected opaque for \(json.prefix(40))…, got \(node.kind)")
            }
            XCTAssertEqual(reason, .invalidShape)
        }
    }

    func testItIsFlowOnlyLikeTheRegistrySays() throws {
        // `placement: 'flow'` — inside a paragraph it is out of position.
        let envelope = """
        {"astVersion":1,"root":{"type":"root","children":[
          {"type":"paragraph","children":[{"type":"crowiFrontmatter","entries":[{"key":"k","value":"v"}]}]}
        ]}}
        """
        let outcome = RenderedAstEnvelopeDecoder.decode(responseValue: try JSONSerialization.jsonObject(with: Data(envelope.utf8)))
        guard case .envelope(let document) = outcome,
              let paragraph = document.children.first,
              let child = paragraph.children.first
        else { return XCTFail("expected a paragraph with one child") }
        XCTAssertEqual(child.kind, .crowiOpaque(reason: .invalidPosition, originalType: "crowiFrontmatter"))
    }
}
