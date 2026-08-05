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

    /// `savedBy ?? author`, applied to the WHOLE user — a revision carrying
    /// both must not print one person's name beside the other's avatar. This
    /// is the web's own rule (`page-history.tsx`), made once at the wire
    /// boundary so the row cannot re-derive it differently.
    func testTheRowShowsSavedByAsOneWholePersonNotAMixOfTwo() throws {
        let json = """
        { "revisions": [ { "_id": "r1", "path": "/x",
          "author": { "username": "old", "name": "Old Author", "image": "/old.png" },
          "savedBy": { "username": "sotarok", "name": "Sotaro", "image": "/new.png" },
          "createdAt": "2026-01-01" } ] }
        """
        let revision = try XCTUnwrap(ListRevisionsResponseLenient.decode(Data(json.utf8)).revisions.first)

        XCTAssertEqual(revision.displayName, "Sotaro")
        XCTAssertEqual(revision.authorUsername, "sotarok")
        XCTAssertEqual(revision.authorImage, "/new.png", "the avatar must come from the same person as the name")
    }

    /// A v1.x revision has no `savedBy` at all; the row falls back to
    /// `author` whole.
    func testARevisionWithoutSavedByFallsBackToTheAuthor() throws {
        let json = """
        { "revisions": [ { "_id": "r1", "path": "/x", "author": { "username": "old", "name": "Old Author", "image": "/old.png" }, "createdAt": "2026-01-01" } ] }
        """
        let revision = try XCTUnwrap(ListRevisionsResponseLenient.decode(Data(json.utf8)).revisions.first)

        XCTAssertEqual(revision.displayName, "Old Author")
        XCTAssertEqual(revision.authorImage, "/old.png")
    }

    /// The "app" chip: set for the token paths, absent for the web editor,
    /// and absent — not crashing, not defaulting to true — for a channel this
    /// build has never heard of.
    func testTheAppChipMarksTokenAuthoredRevisionsOnly() throws {
        func revision(_ editVia: String?) throws -> RevisionMetaLenient {
            let via = editVia.map { "\"editVia\": \"\($0)\"," } ?? ""
            let json = """
            { "revisions": [ { "_id": "r1", "path": "/x", \(via) "createdAt": "2026-01-01" } ] }
            """
            return try XCTUnwrap(ListRevisionsResponseLenient.decode(Data(json.utf8)).revisions.first)
        }

        XCTAssertTrue(try revision("oauth").isAPIEdit)
        XCTAssertTrue(try revision("pat").isAPIEdit)
        XCTAssertFalse(try revision("web").isAPIEdit)
        XCTAssertFalse(try revision(nil).isAPIEdit, "a pre-RFC-0010 revision has no channel to report")
        XCTAssertFalse(try revision("carrier-pigeon").isAPIEdit, "an unknown channel degrades to no chip")
    }

    /// The type gained fields after it was already being cached as JSON.
    /// Every one is optional so a blob written before they existed still
    /// decodes — losing the cached history on upgrade would empty the screen
    /// for anyone offline.
    func testARevisionCachedBeforeTheNewFieldsExistedStillDecodes() throws {
        let legacyBlob = """
        [ { "revisionId": "r1", "authorName": "Sotaro", "authorUsername": "sotarok", "createdAt": "2026-01-01" } ]
        """
        let revisions = try JSONDecoder().decode([RevisionMetaLenient].self, from: Data(legacyBlob.utf8))

        XCTAssertEqual(revisions.first?.displayName, "Sotaro")
        XCTAssertNil(revisions.first?.authorImage)
        XCTAssertFalse(try XCTUnwrap(revisions.first).isAPIEdit)
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
