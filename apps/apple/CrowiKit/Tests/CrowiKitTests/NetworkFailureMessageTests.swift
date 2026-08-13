import XCTest

@testable import CrowiKit

final class NetworkFailureMessageTests: XCTestCase {
    func testTheRecognisedTransportFailuresEachGetTheirOwnSentence() {
        let codes: [URLError.Code] = [
            .notConnectedToInternet, .networkConnectionLost, .timedOut,
            .cannotFindHost, .secureConnectionFailed, .appTransportSecurityRequiresSecureConnection,
        ]
        let messages = codes.compactMap { NetworkFailureMessage.message(for: URLError($0)) }
        XCTAssertEqual(messages.count, codes.count, "every listed code must produce a sentence")
        XCTAssertEqual(Set(messages).count, codes.count, "and a distinct one — a shared sentence would say less than the code knows")
    }

    func testTheCertificateFamilySharesOneSentence() {
        // Four codes, one situation the reader can act on.
        let certificate: [URLError.Code] = [
            .secureConnectionFailed, .serverCertificateUntrusted,
            .serverCertificateHasBadDate, .serverCertificateNotYetValid,
        ]
        let messages = Set(certificate.map { NetworkFailureMessage.message(for: URLError($0)) })
        XCTAssertEqual(messages.count, 1)
    }

    func testAnythingElseIsTheCallersToWord() {
        // The caller falls back to its own copy; this must not guess.
        XCTAssertNil(NetworkFailureMessage.message(for: URLError(.badServerResponse)))
        XCTAssertNil(NetworkFailureMessage.message(for: PageLenientDecodeError.httpError(status: 500)))
        XCTAssertNil(NetworkFailureMessage.message(for: NSError(domain: "wiki.crowi.other", code: -1009)))
    }

    func testNoSentenceLeaksAFrameworkName() {
        for code in [URLError.Code.notConnectedToInternet, .timedOut, .cannotFindHost, .secureConnectionFailed] {
            let message = NetworkFailureMessage.message(for: URLError(code)) ?? ""
            XCTAssertFalse(message.contains("NSURL") || message.contains("com.apple"), message)
        }
    }
}
