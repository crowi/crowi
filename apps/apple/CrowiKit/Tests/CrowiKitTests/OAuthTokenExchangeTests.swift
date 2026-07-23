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
}
