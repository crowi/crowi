import XCTest

@testable import CrowiKit

/// Parity with the web's default avatar, against the corpus both suites read
/// (`packages/web/src/components/__fixtures__/beam-avatar-corpus.json`).
///
/// A derived-value corpus rather than a rendered comparison: the same person
/// wearing a different face per client is invisible in any single screenshot,
/// and only a shared expectation catches it. Reads the repo tree via
/// `#filePath`, like `RenderedAstGoldenCorpusTests`.
final class CrowiBeamAvatarTests: XCTestCase {
    /// `<repo>/apps/apple/CrowiKit/Tests/CrowiKitTests/<this file>` → `<repo>`.
    private static var repositoryRootURL: URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { url = url.deletingLastPathComponent() }
        return url
    }

    private static let corpusURL = repositoryRootURL
        .appendingPathComponent("packages/web/src/components/__fixtures__/beam-avatar-corpus.json")

    private struct Corpus: Decodable {
        let size: Double
        let colors: [String]
        let cases: [Case]

        struct Case: Decodable {
            let name: String
            let hash: Int
            let wrapperColor: String
            let faceColor: String
            let backgroundColor: String
            let wrapperTranslateX: Double
            let wrapperTranslateY: Double
            let wrapperRotate: Double
            let wrapperScale: Double
            let isMouthOpen: Bool
            let isCircle: Bool
            let eyeSpread: Double
            let mouthSpread: Double
            let faceRotate: Double
            let faceTranslateX: Double
            let faceTranslateY: Double
        }
    }

    private func loadCorpus() throws -> Corpus {
        guard let data = try? Data(contentsOf: Self.corpusURL) else {
            XCTFail("shared corpus not found at \(Self.corpusURL.path)")
            throw CocoaError(.fileNoSuchFile)
        }
        return try JSONDecoder().decode(Corpus.self, from: data)
    }

    /// The palette and coordinate space are part of the contract: a face
    /// computed from the right numbers in the wrong colours is still a
    /// different avatar.
    func testTheSpaceAndPaletteMatchTheWebs() throws {
        let corpus = try loadCorpus()

        XCTAssertEqual(corpus.size, CrowiBeamAvatar.size)
        XCTAssertEqual(corpus.colors, CrowiBeamAvatar.colors)
    }

    /// The hash is where a port silently diverges: JavaScript accumulates in
    /// 32-bit signed arithmetic, and a `Int`-width Swift version overflows
    /// nowhere and produces its own plausible-looking faces.
    func testTheSeedHashMatchesTheWebsThirtyTwoBitArithmetic() throws {
        for entry in try loadCorpus().cases {
            XCTAssertEqual(
                CrowiBeamAvatar.hash(entry.name),
                entry.hash,
                "hash diverged for \(entry.name.debugDescription)"
            )
        }
    }

    func testEveryDerivedValueMatchesTheWebs() throws {
        for entry in try loadCorpus().cases {
            let data = CrowiBeamAvatar.data(for: entry.name)
            let subject = entry.name.debugDescription

            XCTAssertEqual(data.wrapperColorHex, entry.wrapperColor, "wrapperColor \(subject)")
            XCTAssertEqual(data.faceColorHex, entry.faceColor, "faceColor \(subject)")
            XCTAssertEqual(data.backgroundColorHex, entry.backgroundColor, "backgroundColor \(subject)")
            XCTAssertEqual(data.wrapperTranslateX, entry.wrapperTranslateX, accuracy: 0.0001, "wrapperTranslateX \(subject)")
            XCTAssertEqual(data.wrapperTranslateY, entry.wrapperTranslateY, accuracy: 0.0001, "wrapperTranslateY \(subject)")
            XCTAssertEqual(data.wrapperRotate, entry.wrapperRotate, accuracy: 0.0001, "wrapperRotate \(subject)")
            XCTAssertEqual(data.wrapperScale, entry.wrapperScale, accuracy: 0.0001, "wrapperScale \(subject)")
            XCTAssertEqual(data.isMouthOpen, entry.isMouthOpen, "isMouthOpen \(subject)")
            XCTAssertEqual(data.isCircle, entry.isCircle, "isCircle \(subject)")
            XCTAssertEqual(data.eyeSpread, entry.eyeSpread, accuracy: 0.0001, "eyeSpread \(subject)")
            XCTAssertEqual(data.mouthSpread, entry.mouthSpread, accuracy: 0.0001, "mouthSpread \(subject)")
            XCTAssertEqual(data.faceRotate, entry.faceRotate, accuracy: 0.0001, "faceRotate \(subject)")
            XCTAssertEqual(data.faceTranslateX, entry.faceTranslateX, accuracy: 0.0001, "faceTranslateX \(subject)")
            XCTAssertEqual(data.faceTranslateY, entry.faceTranslateY, accuracy: 0.0001, "faceTranslateY \(subject)")
        }
    }

    /// Two different names must not collapse onto one face, and one name must
    /// always give the same one — the whole point of a seeded avatar.
    func testTheAvatarIsStablePerNameAndDiffersBetweenNames() {
        XCTAssertEqual(CrowiBeamAvatar.data(for: "sotarok"), CrowiBeamAvatar.data(for: "sotarok"))
        XCTAssertNotEqual(CrowiBeamAvatar.data(for: "sotarok"), CrowiBeamAvatar.data(for: "sotarok-sf"))
    }
}
