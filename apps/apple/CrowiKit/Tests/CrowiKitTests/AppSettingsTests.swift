import XCTest

@testable import CrowiKit

@MainActor
final class AppSettingsTests: XCTestCase {
    private func makeDefaults() -> UserDefaults {
        UserDefaults(suiteName: "wiki.crowi.ios.tests.\(UUID().uuidString)")!
    }

    func testDeveloperModeIsOffUntilItIsAskedFor() {
        XCTAssertFalse(AppSettings(defaults: makeDefaults()).isDeveloperModeEnabled)
    }

    func testDeveloperModeSurvivesTheAppBeingRestarted() {
        let defaults = makeDefaults()
        AppSettings(defaults: defaults).isDeveloperModeEnabled = true
        XCTAssertTrue(AppSettings(defaults: defaults).isDeveloperModeEnabled, "a setting the reader turned on must still be on next launch")
    }

    func testAFailureFromAnErrorCarriesSomethingWorthPastingIntoAReport() {
        let failure = DisplayableFailure(
            message: "Sign-in failed. Try again.",
            error: NSError(domain: "wiki.crowi.test", code: -42, userInfo: [NSLocalizedDescriptionKey: "the underlying words"])
        )
        XCTAssertEqual(failure.message, "Sign-in failed. Try again.", "the reader's sentence is the app's own")
        let detail = try? XCTUnwrap(failure.detail)
        XCTAssertTrue(detail?.contains("wiki.crowi.test") == true)
        XCTAssertTrue(detail?.contains("-42") == true)
        XCTAssertTrue(detail?.contains("the underlying words") == true)
    }

    func testAFailureTheAppDecidedItselfHasNothingUnderneath() {
        XCTAssertNil(DisplayableFailure(message: "This does not look like a Crowi instance.").detail)
    }
}

@MainActor
final class AppAppearanceSettingTests: XCTestCase {
    private func makeDefaults() -> UserDefaults {
        UserDefaults(suiteName: "wiki.crowi.ios.tests.\(UUID().uuidString)")!
    }

    func testItFollowsTheDeviceUntilToldOtherwise() {
        XCTAssertEqual(AppSettings(defaults: makeDefaults()).appearance, .system)
    }

    func testAChoiceSurvivesTheAppBeingRestarted() {
        let defaults = makeDefaults()
        AppSettings(defaults: defaults).appearance = .light
        XCTAssertEqual(AppSettings(defaults: defaults).appearance, .light)
    }

    func testAStoredValueThisBuildDoesNotRecogniseFallsBackToTheDevice() {
        // A retired case must not leave the reader on a side the app picked.
        let defaults = makeDefaults()
        defaults.set("sepia", forKey: AppSettings.appearanceKey)
        XCTAssertEqual(AppSettings(defaults: defaults).appearance, .system)
    }

    func testEveryCaseIsOfferedAndLabelledDistinctly() {
        let labels = AppAppearance.allCases.map(\.label)
        XCTAssertEqual(Set(labels).count, AppAppearance.allCases.count)
        XCTAssertEqual(AppAppearance.allCases.count, 3)
    }
}
