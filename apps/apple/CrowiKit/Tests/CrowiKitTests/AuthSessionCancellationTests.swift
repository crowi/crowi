import AuthenticationServices
import XCTest

@testable import CrowiKit

/// Closing the sign-in sheet without signing in is not a failure. ASWAS
/// reports it as an error only because the call has to resolve somehow, and
/// showing it lands "com.apple.AuthenticationServices.WebAuthenticationSession
/// error 1" on screen — telling the reader their own tap malfunctioned.
final class AuthSessionCancellationTests: XCTestCase {
    func testTheCancelledLoginErrorIsRecognised() {
        let cancelled = NSError(
            domain: ASWebAuthenticationSessionError.errorDomain,
            code: ASWebAuthenticationSessionError.canceledLogin.rawValue
        )
        XCTAssertTrue(ASWebAuthenticationSessionRunner.isUserCancellation(cancelled))
    }

    func testOtherSessionFailuresAreStillFailures() {
        // A missing presentation anchor is a real bug and must stay visible.
        let notPresented = NSError(
            domain: ASWebAuthenticationSessionError.errorDomain,
            code: ASWebAuthenticationSessionError.presentationContextNotProvided.rawValue
        )
        XCTAssertFalse(ASWebAuthenticationSessionRunner.isUserCancellation(notPresented))
    }

    func testAnUnrelatedErrorSharingTheCodeIsNotACancellation() {
        // Code 1 is not rare; the domain is what makes it this error.
        XCTAssertFalse(ASWebAuthenticationSessionRunner.isUserCancellation(URLError(.unknown)))
        XCTAssertFalse(ASWebAuthenticationSessionRunner.isUserCancellation(NSError(domain: "wiki.crowi.other", code: 1)))
    }
}
