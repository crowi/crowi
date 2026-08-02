import XCTest

@testable import CrowiKit

/// RFC-0016 §5.2 — the remaining hand-written lenient decoders
/// (comments/bookmark/backlinks/revisions/profile), each following the same
/// `AppInfoLenient` pattern: optionals-first, degrade (never throw) on an
/// unexpected/missing field.
final class RemainingLenientDecodersTests: XCTestCase {
    // MARK: - Comments

    func testListCommentsDecodesCreatorNameAndUsername() throws {
        let json = """
        { "comments": [ { "_id": "c1", "creator": { "username": "sotarok", "name": "Sotaro" }, "comment": "nice page", "createdAt": "2026-01-01" } ] }
        """
        let response = try ListCommentsResponseLenient.decode(Data(json.utf8))

        XCTAssertEqual(response.comments.first?.creatorUsername, "sotarok")
        XCTAssertEqual(response.comments.first?.comment, "nice page")
    }

    func testListCommentsDegradesWhenCreatorIsABareStringId() throws {
        let json = """
        { "comments": [ { "_id": "c1", "creator": "user-id-only", "comment": "hi" } ] }
        """
        let response = try ListCommentsResponseLenient.decode(Data(json.utf8))

        let comment = try XCTUnwrap(response.comments.first)
        XCTAssertNil(comment.creatorUsername)
        XCTAssertEqual(comment.comment, "hi")
    }

    /// `creator.image` (`PageUserSchema.image`) — the avatar URL
    /// `WorkspaceAvatarView` renders in the reader's comments section.
    func testListCommentsDecodesCreatorImage() throws {
        let json = """
        { "comments": [ { "_id": "c1", "creator": { "username": "sotarok", "name": "Sotaro", "image": "/api/attachments/by-key/user/sotarok.png" }, "comment": "nice page" } ] }
        """
        let response = try ListCommentsResponseLenient.decode(Data(json.utf8))

        XCTAssertEqual(response.comments.first?.creatorImage, "/api/attachments/by-key/user/sotarok.png")
    }

    // MARK: - Bookmark

    func testBookmarkResponseDecodesPresence() throws {
        let present = try BookmarkResponseLenient.decode(Data("{ \"bookmark\": { \"_id\": \"b1\" } }".utf8))
        let absent = try BookmarkResponseLenient.decode(Data("{ \"bookmark\": null }".utf8))

        XCTAssertTrue(present.isBookmarked)
        XCTAssertFalse(absent.isBookmarked)
    }

    // MARK: - Backlinks

    func testBacklinksDecodesFromPagePath() throws {
        let json = """
        { "backlinks": [ { "_id": "bl1", "page": "p1", "fromPage": { "_id": "p2", "path": "/other" }, "fromRevision": { "_id": "r1" }, "updatedAt": "2026-01-01" } ], "hasNext": true }
        """
        let response = try GetBacklinksResponseLenient.decode(Data(json.utf8))

        XCTAssertEqual(response.backlinks.first?.fromPagePath, "/other")
        XCTAssertTrue(response.hasNext)
    }

    func testBacklinksSkipsAMalformedRowRatherThanThrowing() throws {
        let json = """
        { "backlinks": [ { "_id": "bl1" } ], "hasNext": false }
        """
        let response = try GetBacklinksResponseLenient.decode(Data(json.utf8))

        XCTAssertTrue(response.backlinks.isEmpty)
    }

    // MARK: - Revisions

    func testListRevisionsDecodesAuthorAndCreatedAt() throws {
        let json = """
        { "revisions": [ { "_id": "r1", "path": "/x", "author": { "username": "sotarok", "name": "Sotaro" }, "createdAt": "2026-01-01" } ], "pager": { "prev": null, "next": null, "offset": 0 } }
        """
        let response = try ListRevisionsResponseLenient.decode(Data(json.utf8))

        XCTAssertEqual(response.revisions.first?.authorUsername, "sotarok")
    }

    func testGetRevisionDecodesBody() throws {
        let json = """
        { "revision": { "_id": "r1", "path": "/x", "body": "# past revision" } }
        """
        let response = try GetRevisionResponseLenient.decode(Data(json.utf8))

        XCTAssertEqual(response.revision.body, "# past revision")
    }

    // MARK: - Profile

    func testProfileDecodesMinimalFields() throws {
        let json = """
        { "id": "u1", "username": "sotarok", "name": "Sotaro", "email": "s@example.com", "lang": "en", "theme": "system", "image": null, "hasPassword": true, "createdAt": "2026-01-01" }
        """
        let profile = try ProfileLenient.decode(Data(json.utf8))

        XCTAssertEqual(profile.username, "sotarok")
        XCTAssertEqual(profile.id, "u1")
        XCTAssertNil(profile.image)
    }

    /// `image` — the avatar URL `ProfileView` renders via `WorkspaceAvatarView`.
    func testProfileDecodesImageWhenPresent() throws {
        let json = """
        { "id": "u1", "username": "sotarok", "name": "Sotaro", "email": "s@example.com", "image": "/api/attachments/by-key/user/sotarok.png", "createdAt": "2026-01-01" }
        """
        let profile = try ProfileLenient.decode(Data(json.utf8))

        XCTAssertEqual(profile.image, "/api/attachments/by-key/user/sotarok.png")
    }

    func testUserPageResponseDecodesNestedUserAndCounts() throws {
        let json = """
        { "user": { "_id": "u1", "username": "sotarok", "name": "Sotaro", "email": "s@example.com", "image": "/api/attachments/by-key/user/sotarok.png", "createdAt": "2026-01-01" }, "createdPagesCount": 5, "bookmarksCount": 2 }
        """
        let response = try UserPageResponseLenient.decode(Data(json.utf8))

        XCTAssertEqual(response.username, "sotarok")
        XCTAssertEqual(response.createdPagesCount, 5)
        XCTAssertEqual(response.image, "/api/attachments/by-key/user/sotarok.png")
    }

    /// feature-profile-stats-and-page-total — the two counts the profile's
    /// stat strip added.
    func testUserPageResponseDecodesTheLikeAndCommentCounts() throws {
        let json = """
        { "user": { "_id": "u1", "username": "sotarok" }, "createdPagesCount": 5, "bookmarksCount": 2, "likesCount": 342, "commentsCount": 89 }
        """
        let response = try UserPageResponseLenient.decode(Data(json.utf8))

        XCTAssertEqual(response.likesCount, 342)
        XCTAssertEqual(response.commentsCount, 89)
    }

    /// A server predating the extension sends neither count. They must decode
    /// to `nil` — the strip drops a missing stat, and a `0` default would
    /// have it print "0 Likes" as though that were measured.
    func testAPreExtensionServerLeavesTheNewCountsNilRatherThanZero() throws {
        let json = """
        { "user": { "_id": "u1", "username": "sotarok" }, "createdPagesCount": 5, "bookmarksCount": 2 }
        """
        let response = try UserPageResponseLenient.decode(Data(json.utf8))

        XCTAssertNil(response.likesCount)
        XCTAssertNil(response.commentsCount)
    }

    func testRecentlyViewedPagesDecodesPageArray() throws {
        let json = """
        { "pages": [ { "_id": "p1", "path": "/x" } ] }
        """
        let response = try RecentlyViewedPagesResponseLenient.decode(Data(json.utf8))

        XCTAssertEqual(response.pages.first?.path, "/x")
    }

    // MARK: - Shared degrade behavior

    func testNonObjectResponsesThrowNotAnObjectAcrossEveryDecoder() {
        XCTAssertThrowsError(try ListCommentsResponseLenient.decode(Data("[]".utf8)))
        XCTAssertThrowsError(try BookmarkResponseLenient.decode(Data("[]".utf8)))
        XCTAssertThrowsError(try GetBacklinksResponseLenient.decode(Data("[]".utf8)))
        XCTAssertThrowsError(try ListRevisionsResponseLenient.decode(Data("[]".utf8)))
        XCTAssertThrowsError(try ProfileLenient.decode(Data("[]".utf8)))
        XCTAssertThrowsError(try RecentlyViewedPagesResponseLenient.decode(Data("[]".utf8)))
    }
}
