import XCTest

@testable import CrowiKit

/// `feature-ios-phase2-write` — the shared `{ error: { code, message } }`
/// envelope decode every write flow discriminates on. Fixtures copy the
/// LITERAL bodies `handlers/page.ts`'s helpers emit, so these tests break
/// if the server wire shape drifts.
final class APIErrorEnvelopeLenientTests: XCTestCase {
    func testDecodesTheLiteralServerHelperBody() {
        // `INVALID_GRANT_BODY` (`handlers/page.ts`), verbatim.
        let data = Data(
            """
            { "error": { "code": "INVALID_GRANT", "message": "grant must be one of 1 (public), 2 (restricted), 3 (specified), 4 (owner)" } }
            """.utf8)

        let envelope = APIErrorEnvelopeLenient.decode(data)

        XCTAssertEqual(envelope.code, "INVALID_GRANT")
        XCTAssertEqual(envelope.message, "grant must be one of 1 (public), 2 (restricted), 3 (specified), 4 (owner)")
    }

    func testUnknownCodePassesThroughForTheCallerToDegradeOn() {
        let data = Data("""
            { "error": { "code": "SOME_FUTURE_CODE", "message": "hi" } }
            """.utf8)

        XCTAssertEqual(APIErrorEnvelopeLenient.decode(data).code, "SOME_FUTURE_CODE")
    }

    func testGarbageAndNonEnvelopeBodiesDegradeToAllNil() {
        let allNil = APIErrorEnvelopeLenient(code: nil, message: nil)

        XCTAssertEqual(APIErrorEnvelopeLenient.decode(Data()), allNil)
        XCTAssertEqual(APIErrorEnvelopeLenient.decode(Data("not json at all".utf8)), allNil)
        XCTAssertEqual(APIErrorEnvelopeLenient.decode(Data("[1, 2, 3]".utf8)), allNil)
        XCTAssertEqual(APIErrorEnvelopeLenient.decode(Data("{ \"message\": \"no error key\" }".utf8)), allNil)
        // `error` present but not an object (some frameworks emit a bare string).
        XCTAssertEqual(APIErrorEnvelopeLenient.decode(Data("{ \"error\": \"rate_limited\" }".utf8)), allNil)
    }

    func testNonStringCodeOrMessageDegradesToNilFieldwise() {
        let data = Data("""
            { "error": { "code": 500, "message": "still readable" } }
            """.utf8)

        let envelope = APIErrorEnvelopeLenient.decode(data)

        XCTAssertNil(envelope.code)
        XCTAssertEqual(envelope.message, "still readable")
    }

    func testWriteRequestErrorCarriesStatusPlusEnvelope() {
        let data = Data("""
            { "error": { "code": "PAGE_NOT_FOUND", "message": "Page not found" } }
            """.utf8)

        let error = WriteRequestError.from(status: 404, data: data)

        XCTAssertEqual(error.status, 404)
        XCTAssertEqual(error.code, "PAGE_NOT_FOUND")
        XCTAssertEqual(error.message, "Page not found")
    }
}
