import Foundation
import XCTest

/// The opt-in switch for the two spike tests that talk to a REAL Crowi.
///
/// They used to hardcode `http://localhost:4301` and skip themselves when
/// nothing answered — which reads as safe and is not: whoever happens to
/// have that port answering runs two tests nobody else runs, against a
/// server whose contents and lifecycle the suite does not control. A dev
/// server restarting mid-run answers 200 with a body that has not finished
/// becoming itself, and the result is a plain assertion failure in a unit
/// suite, disconnected from any code under test and gone by the next run.
///
/// So they are off unless asked for, and when asked for they are strict:
/// an unreachable origin is a FAILURE, not a skip. A live check that
/// silently declines to run is not a check.
///
///     CROWI_LIVE_ORIGIN=http://localhost:4301 swift test
enum LiveDevCrowi {
    static let environmentKey = "CROWI_LIVE_ORIGIN"

    /// Throws `XCTSkip` on an ordinary run; returns the requested origin
    /// when one was asked for.
    static func origin() throws -> URL {
        guard let raw = ProcessInfo.processInfo.environment[environmentKey], !raw.isEmpty else {
            throw XCTSkip("set \(environmentKey) to run the live half of this spike against a real Crowi")
        }
        guard let url = URL(string: raw), url.scheme != nil, url.host != nil else {
            XCTFail("\(environmentKey) is not a usable origin: \(raw)")
            throw XCTSkip("unusable \(environmentKey)")
        }
        return url
    }
}
