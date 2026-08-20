import XCTest

@testable import CrowiKit

/// An attachment URL is same-origin, so without recognising it first the
/// reader goes looking for a page called `/api/attachments/<id>` and reports
/// that it could not load one.
final class AttachmentLinkTests: XCTestCase {
    private let id = "6a7567cb7fb9c4c95f9b3603"

    func testEveryFormTheWebRecognises() {
        for url in [
            "/api/attachments/\(id)",
            "/api/v2/attachments/\(id)",
            "/files/\(id)",
            "/api/attachments/\(id)/original",
            "https://wiki.example.com/api/attachments/\(id)",
            "/api/attachments/\(id)?download=1",
            "/api/attachments/\(id)#page=2",
        ] {
            XCTAssertEqual(WorkspaceLinkRouter.attachmentId(in: url), id, url)
        }
    }

    func testTheIdIsLowerCased() {
        XCTAssertEqual(WorkspaceLinkRouter.attachmentId(in: "/api/attachments/\(id.uppercased())"), id)
    }

    func testAnythingDeeperIsNotAnAttachmentReference() {
        // The web's rule: `…/<id>/extra` is some other endpoint.
        XCTAssertNil(WorkspaceLinkRouter.attachmentId(in: "/api/attachments/\(id)/extra"))
        XCTAssertNil(WorkspaceLinkRouter.attachmentId(in: "/api/attachments/\(id)/meta"))
    }

    func testOrdinaryPagesAreNotAttachments() {
        XCTAssertNil(WorkspaceLinkRouter.attachmentId(in: "/Survey/2026/07/23/report"))
        XCTAssertNil(WorkspaceLinkRouter.attachmentId(in: "/\(id)"), "a share URL is a page, not an attachment")
        XCTAssertNil(WorkspaceLinkRouter.attachmentId(in: "/api/attachments/not-an-object-id"))
    }

    func testTheMetadataCarriesWhatAPreviewNeeds() throws {
        let json = """
        {"_id":"\(id)","url":"/api/attachments/\(id)","originalUrl":"/api/attachments/\(id)/original",
         "originalName":"報告書.pdf","fileFormat":"application/pdf"}
        """
        let meta = try AttachmentMetaLenient.decode(Data(json.utf8))
        // The name is what tells the system previewer what it is looking at.
        XCTAssertEqual(meta.originalName, "報告書.pdf")
        XCTAssertEqual(meta.fileFormat, "application/pdf")
        XCTAssertEqual(meta.originalUrl, "/api/attachments/\(id)/original")
    }

    func testMetadataWithoutTheNewFieldsStillDecodes() throws {
        // An older server leaves them off; the preview falls back to the id.
        let json = #"{"_id":"x","url":"/api/attachments/x"}"#
        let meta = try AttachmentMetaLenient.decode(Data(json.utf8))
        XCTAssertNil(meta.originalName)
        XCTAssertNil(meta.fileFormat)
    }
}
