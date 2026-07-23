import XCTest

@testable import CrowiKit

/// Pins the OAuth form-body encoder independently of the higher-level sign-in
/// flow. OAuth tokens are opaque strings; even if Crowi currently emits
/// base64url/JWT-shaped values, the encoder must not rely on that.
final class OAuthTokenExchangeTests: XCTestCase {
    func testFormEncodeEscapesFormDelimitersInsideValues() {
        let encoded = String(
            data: OAuthTokenExchange.formEncode([
                ("token", "abc+def/ghi=="),
                ("note", "a&b=c d"),
            ]),
            encoding: .utf8
        )

        XCTAssertEqual(encoded, "token=abc%2Bdef%2Fghi%3D%3D&note=a%26b%3Dc%20d")
    }

    func testFormEncodeEscapesFormDelimitersInsideKeysToo() {
        let encoded = String(
            data: OAuthTokenExchange.formEncode([
                ("weird&key", "value"),
            ]),
            encoding: .utf8
        )

        XCTAssertEqual(encoded, "weird%26key=value")
    }

    /// external review (ios-review) finding — the encoder must stick to RFC
    /// 3986 unreserved characters only, not `CharacterSet.urlQueryAllowed`
    /// (which passes non-ASCII text like this through unescaped, since
    /// `urlQueryAllowed` is meant for whole URLs, not a single
    /// `application/x-www-form-urlencoded` field).
    func testFormEncodeEscapesNonASCIICharactersInValues() {
        let encoded = String(
            data: OAuthTokenExchange.formEncode([
                ("note", "café☕")
            ]),
            encoding: .utf8
        )

        XCTAssertEqual(encoded, "note=caf%C3%A9%E2%98%95")
    }
}
