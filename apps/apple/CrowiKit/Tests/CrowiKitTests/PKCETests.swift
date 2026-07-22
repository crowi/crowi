import XCTest

@testable import CrowiKit

/// Phase 0 gate A — PKCE S256 must match the server's verification
/// (`packages/api/src/util/pkce.ts:verifyPkceS256`) byte-for-byte: the
/// server recomputes `base64url(sha256(codeVerifier))` and compares it
/// against the `codeChallenge` the client sent at authorize time.
final class PKCETests: XCTestCase {
    /// A fixed vector: sha256("test-verifier") base64url-encoded, computed
    /// independently (Python `hashlib.sha256(b"test-verifier").digest()`
    /// then base64url, no padding) so this test does not just check
    /// "encode-then-decode round-trips" but an externally-verifiable value.
    func testChallengeMatchesFixedVector() {
        let verifier = "test-verifier"
        let expectedChallenge = "JBbiqONGWPaAmwXk_8bT6UnlPfrn65D32eZlJS-zGG0"
        XCTAssertEqual(PKCE.challenge(forVerifier: verifier), expectedChallenge)
    }

    func testGeneratedVerifierIsWithinRFC7636Bounds() {
        let (verifier, challenge) = PKCE.generate()
        // RFC 7636 §4.1: 43-128 characters, unreserved (base64url gives us
        // exactly that alphabet already).
        XCTAssertGreaterThanOrEqual(verifier.count, 43)
        XCTAssertLessThanOrEqual(verifier.count, 128)
        XCTAssertFalse(challenge.isEmpty)
        // base64url, no padding: never contains '+', '/', or '='.
        XCTAssertFalse(verifier.contains("+"))
        XCTAssertFalse(verifier.contains("/"))
        XCTAssertFalse(verifier.contains("="))
    }

    func testChallengeIsDeterministicForSameVerifier() {
        let (verifier, challenge1) = PKCE.generate()
        let challenge2 = PKCE.challenge(forVerifier: verifier)
        XCTAssertEqual(challenge1, challenge2)
    }

    func testTwoGeneratedPairsDiffer() {
        let (verifier1, _) = PKCE.generate()
        let (verifier2, _) = PKCE.generate()
        XCTAssertNotEqual(verifier1, verifier2)
    }
}
