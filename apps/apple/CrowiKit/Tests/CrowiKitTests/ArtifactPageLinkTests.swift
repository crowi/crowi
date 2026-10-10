import XCTest

@testable import CrowiKit

/// Which wiki page a link inside an HTML artifact opens. The tables are the
/// shared resolver's own (`packages/api-contract/src/util/artifact-link.test.ts`
/// and `artifact-navigation.test.ts`), so a link opens the same page here as
/// on the web, and a link the web refuses is refused here.
final class ArtifactPageLinkTests: XCTestCase {
    private func resolve(_ source: String, _ href: String) -> String? {
        ArtifactPageLink.resolve(sourcePagePath: source, rawHref: href)
    }

    // MARK: - Resolving

    func testResolvesTheWebsAcceptedLinks() {
        let rows: [(label: String, source: String, href: String, pagePath: String)] = [
            ("sibling", "/team/artifact", "guide", "/team/guide"),
            ("./", "/team/artifact", "./guide", "/team/guide"),
            ("parent with fragment", "/team/artifact", "../guide#overview", "/guide"),
            ("trailing-slash base is still sibling-based", "/team/artifact/", "guide", "/team/guide"),
            ("root base", "/", "guide", "/guide"),
            ("./ keeps the trailing slash", "/team/artifact", "./", "/team/"),
            ("dot-only final segment keeps the trailing slash", "/team/artifact", ".", "/team/"),
            ("root link", "/team/artifact", "/", "/"),
            ("absolute link ignores the base", "/a/b/c", "/team/guide", "/team/guide"),
            ("space", "/team/artifact", "my page", "/team/my page"),
            ("plus", "/team/artifact", "my+page", "/team/my page"),
            ("%20", "/team/artifact", "my%20page", "/team/my page"),
            ("%2B", "/team/artifact", "my%2Bpage", "/team/my page"),
            ("Unicode and fragment plus", "/team/artifact", "資料#章+1", "/team/資料"),
            ("base with %", "/discount/100%off", "./guide", "/discount/guide"),
            ("base ending in a bare %", "/team/100%", "guide", "/team/guide"),
            ("base with a colon, absolute link", "/RFC: design/demo", "/team/guide", "/team/guide"),
            ("escaped % in an absolute link", "/x/y", "/discount/100%25off", "/discount/100%off"),
            ("escaped % in a relative link", "/team/artifact", "100%25done", "/team/100%done"),
            ("colon", "/x/y", "/team/section:1", "/team/section:1"),
            ("encoded colon", "/x/y", "/team/section%3A1", "/team/section:1"),
            ("colon after ./", "/team/artifact", "./section:1", "/team/section:1"),
            ("an encoded slash name survives as a literal", "/x/y", "/a/%252fb", "/a/%2fb"),
            ("literal %2e%2e is a page name, not a dot segment", "/x/y", "/team/%252e%252e", "/team/%2e%2e"),
            ("encoded dot segments resolve", "/team/artifact", "%2e%2e/guide", "/guide"),
            ("a page name that looks like a Crowi path with -", "/x/y", "/-foo", "/-foo"),
        ]
        for row in rows {
            XCTAssertEqual(resolve(row.source, row.href), row.pagePath, row.label)
        }
    }

    func testRefusesTheWebsRejectedLinks() {
        let rows: [(label: String, source: String, href: String)] = [
            ("root overflow", "/team/artifact", "../../guide"),
            ("dot segments reaching a reserved route", "/team/artifact", "/x/%2e%2e/admin"),
            ("double slash", "/team/artifact", "/a//b"),
            ("encoded slash", "/team/artifact", "/%2fadmin"),
            ("encoded backslash", "/team/artifact", "/%5cadmin"),
            ("invalid escape", "/team/artifact", "/%2G"),
            ("overlong UTF-8", "/team/artifact", "/%C0%AF"),
            ("bad escape", "/team/artifact", "/%ZZ"),
            ("raw %", "/team/artifact", "/100%done"),
            ("raw % at the end", "/team/artifact", "/100%"),
            ("raw % relative", "/team/artifact", "100%off"),
            ("query", "/team/artifact", "/guide?edit=1"),
            ("absolute URL", "/team/artifact", "https://wiki.example/guide"),
            ("protocol-relative", "/team/artifact", "//wiki.example/guide"),
            ("scheme-like relative", "/team/artifact", "javascript:alert(1)"),
            ("fragment only", "/team/artifact", "#top"),
            ("reserved route", "/team/artifact", "/admin"),
            ("reserved after relative resolution", "/admin/x", "users"),
        ]
        for row in rows {
            XCTAssertNil(resolve(row.source, row.href), row.label)
        }
    }

    /// The lone-surrogate row of the web's table is not expressible: a Swift
    /// `String` cannot hold an unpaired surrogate.
    func testRefusesAnUnsafeSourcePagePath() {
        let sources = ["team/artifact", "/team//artifact", "/team/a\nb", "/team\\artifact", "/team/a?b", "/team/a#b", "/team/a+b", "/team/../artifact", "/" + String(repeating: "a", count: 4096), ""]
        for source in sources {
            XCTAssertNil(resolve(source, "/team/guide"), source)
        }
    }

    func testRefusesATargetWhoseHrefExceedsTheLimit() {
        XCTAssertNil(resolve("/x/y", "/" + String(repeating: "資", count: 1400)))
    }

    // MARK: - Parsing

    func testParsesRootRelativeAndBareNames() throws {
        XCTAssertEqual(ArtifactPageLink.parse("/"), .init(absolute: true, segments: [], trailingSlash: true, fragment: nil))
        XCTAssertEqual(ArtifactPageLink.parse("/team/guide"), .init(absolute: true, segments: ["team", "guide"], trailingSlash: false, fragment: nil))
        XCTAssertEqual(ArtifactPageLink.parse("./guide"), .init(absolute: false, segments: [".", "guide"], trailingSlash: false, fragment: nil))
        XCTAssertEqual(ArtifactPageLink.parse("../guide#overview"), .init(absolute: false, segments: ["..", "guide"], trailingSlash: false, fragment: "overview"))
        XCTAssertEqual(ArtifactPageLink.parse("./"), .init(absolute: false, segments: ["."], trailingSlash: true, fragment: nil))
        XCTAssertEqual(ArtifactPageLink.parse("my+page")?.segments, ["my+page"])
        XCTAssertEqual(ArtifactPageLink.parse("資料#章+1")?.fragment, "章+1")
    }

    func testDecodesEachSegmentExactlyOnce() {
        XCTAssertEqual(ArtifactPageLink.parse("100%25done")?.segments, ["100%done"])
        XCTAssertEqual(ArtifactPageLink.parse("/%252e%252e/admin")?.segments, ["%2e%2e", "admin"])
        XCTAssertEqual(ArtifactPageLink.parse("my%20page")?.segments, ["my page"])
        XCTAssertEqual(ArtifactPageLink.parse("%E8%B3%87%E6%96%99")?.segments, ["資料"])
        XCTAssertEqual(ArtifactPageLink.parse("x/%2e%2e/y")?.segments, ["x", "..", "y"])
        XCTAssertEqual(ArtifactPageLink.parse("/section%3A1")?.segments, ["section:1"])
    }

    func testRefusesMalformedLinks() {
        let rejected = [
            // raw % that is not a valid escape
            "100%done", "100%off", "%ZZ", "%2G", "100%", "/100%", "/%2G", "/%ZZ", "/100%done",
            // invalid UTF-8 and encoded delimiters
            "/%C0%AF", "/%80", "/%ED%A0%80", "/%2fadmin", "/%2Fadmin", "/%5cadmin", "a%3Fb", "a%23b",
            // scheme-like first segment
            "https://wiki.example/guide", "javascript:alert(1)", "mailto:a@b", "section:1", "a+b.c-d:x",
            // query, protocol-relative, fragment-only, empty segments
            "/guide?edit=1", "?a=1", "//wiki.example/guide", "#top", "/a//b", "a//b", "",
            // control characters, backslash, surrounding whitespace
            "/a\nb", "/a\u{0000}b", "/a\u{007f}b", "/a\u{0085}b", "/a\\b", " /a", "/a ", "\t/a",
            // empty, double or unsafe fragment
            "/a#", "/a#b#c", "/a#%", "/a#%ZZ", "/a#%25", "/a#a%5Cb", "/a#%0A", "/a#%C0%AF",
        ]
        for href in rejected {
            XCTAssertNil(ArtifactPageLink.parse(href), href)
        }
    }

    func testKeepsColonsInsidePageNames() {
        XCTAssertEqual(ArtifactPageLink.parse("/team/section:1")?.segments, ["team", "section:1"])
        XCTAssertEqual(ArtifactPageLink.parse("./section:1")?.segments, [".", "section:1"])
        XCTAssertEqual(ArtifactPageLink.parse("../a:b")?.segments, ["..", "a:b"])
        XCTAssertEqual(ArtifactPageLink.parse("/RFC: design/demo")?.segments, ["RFC: design", "demo"])
    }

    func testAFragmentMayHoldQueryAndSlashCharacters() {
        XCTAssertEqual(ArtifactPageLink.parse("/a#x?y/z")?.fragment, "x?y/z")
        XCTAssertEqual(ArtifactPageLink.parse("/a#%E7%AB%A0")?.fragment, "章")
    }

    func testEnforcesTheLengthBound() {
        let prefix = "/"
        XCTAssertNotNil(ArtifactPageLink.parse(prefix + String(repeating: "a", count: ArtifactPageLink.maxLength - 1)))
        XCTAssertNil(ArtifactPageLink.parse(prefix + String(repeating: "a", count: ArtifactPageLink.maxLength)))
    }

    // MARK: - Which pages may be opened

    func testAllowsOrdinaryPages() {
        let allowed = [
            "/", "/team/guide", "/team/guide/", "/apiary", "/meeting", "/team/admin", "/team/section:1", "/discount/100%off",
            "/user/alice", "/user/alice/", "/user/alice/notes", "/docs/507f1f77bcf86cd799439011", "/-foo", "/team/-/foo",
            "/a.b/c", "/資料/日本語 ページ", "/notifications-guide", "/loginfo",
        ]
        for path in allowed {
            XCTAssertEqual(ArtifactPageLink.classify(path), .page, path)
        }
    }

    func testRefusesReservedRoutesAndMalformedPaths() {
        let reservedNames = ["installer", "register", "login", "logout", "admin", "me", "files", "trash", "paste", "comments", "api"]
        let appRoutes = ["activate", "confirm-email", "forgot-password", "reset-password", "invite", "oauth"]
        let backend = ["collab", "presence", "notifications", "socket.io", "logo", "images"]
        let userTabs = ["bookmarks", "comments", "activities", "pages", "recent-create", "recent-edit"]
        var refused: [String] = []
        for name in reservedNames {
            refused += ["/\(name)", "/\(name)/", "/\(name)/x"]
        }
        refused += ["/ADMIN", "/Admin/users"]
        for name in appRoutes {
            refused += ["/\(name)", "/\(name)/x"]
        }
        refused += ["/_artifact-frame", "/_edit", "/_r/abc", "/_history", "/_search", "/_attachments", "/_notifications", "/_user", "/_next/static/x", "/.well-known/x", "/.hidden", "/-/foo", "/-", "/-/"]
        for name in backend {
            refused += ["/\(name)", "/\(name)/x"]
        }
        refused += ["/favicon.ico", "/favicon.ico/x", "/user", "/user/", "/User"]
        for tab in userTabs {
            refused += ["/user/alice/\(tab)", "/user/alice/\(tab)/x"]
        }
        refused += ["/user/alice/Bookmarks", "/507f1f77bcf86cd799439011", "/507f1f77bcf86cd799439011/", "/507F1F77BCF86CD799439011"]
        refused += ["/a^b", "/a$b", "/a*b", "/a / b", "/a/edit", "/a/edit/", "/notes.md", "/notes.md/"]
        refused += ["team", "/a//b", "/a\\b", "/a?b", "/a#b", "/a+b", "/a/../b", "/a/./b"]
        for path in refused {
            XCTAssertNotEqual(ArtifactPageLink.classify(path), .page, path)
        }
    }

    func testSeparatesReservedRoutesFromMalformedPaths() {
        XCTAssertEqual(ArtifactPageLink.classify("/team/guide"), .page)
        XCTAssertEqual(ArtifactPageLink.classify("/ADMIN"), .reservedRoute)
        XCTAssertEqual(ArtifactPageLink.classify("/-"), .reservedRoute)
        XCTAssertEqual(ArtifactPageLink.classify("/a/edit/"), .reservedRoute)
        XCTAssertEqual(ArtifactPageLink.classify("/507f1f77bcf86cd799439011"), .reservedRoute)
        XCTAssertEqual(ArtifactPageLink.classify("/a//b"), .invalidPath)
        XCTAssertEqual(ArtifactPageLink.classify("/a+b"), .invalidPath)
        XCTAssertEqual(ArtifactPageLink.classify(""), .invalidPath)
    }

    // MARK: - Path arithmetic

    func testResolvingNeedsNoBaseForAnAbsoluteLink() throws {
        func link(_ href: String) throws -> ArtifactPageLink.ParsedLink { try XCTUnwrap(ArtifactPageLink.parse(href), href) }
        XCTAssertEqual(ArtifactPageLink.resolvePath(try link("/team/guide"), sourcePagePath: nil), "/team/guide")
        XCTAssertEqual(ArtifactPageLink.resolvePath(try link("/x/%2e%2e/admin"), sourcePagePath: nil), "/admin")
        XCTAssertEqual(ArtifactPageLink.resolvePath(try link("/a%20b/"), sourcePagePath: nil), "/a b/")
    }

    func testARelativeLinkNeedsACanonicalBase() throws {
        func link(_ href: String) throws -> ArtifactPageLink.ParsedLink { try XCTUnwrap(ArtifactPageLink.parse(href), href) }
        XCTAssertNil(ArtifactPageLink.resolvePath(try link("guide"), sourcePagePath: nil))
        XCTAssertNil(ArtifactPageLink.resolvePath(try link("guide"), sourcePagePath: "team/artifact"))
        XCTAssertNil(ArtifactPageLink.resolvePath(try link("../../guide"), sourcePagePath: "/team/artifact"))
        XCTAssertEqual(ArtifactPageLink.resolvePath(try link("../admin"), sourcePagePath: "/team/artifact"), "/admin")
        XCTAssertEqual(ArtifactPageLink.resolvePath(try link("../admin"), sourcePagePath: "/team/sub/artifact"), "/team/admin")
        XCTAssertEqual(ArtifactPageLink.resolvePath(try link(".."), sourcePagePath: "/team/sub/artifact"), "/team/")
    }

    func testDoesNotDecodeASecondTime() throws {
        let link = try XCTUnwrap(ArtifactPageLink.parse("/%252e%252e/admin"))
        XCTAssertEqual(ArtifactPageLink.resolvePath(link, sourcePagePath: nil), "/%2e%2e/admin")
    }
}

/// The script that hands the app a tapped artifact link.
final class ArtifactLinkBridgeTests: XCTestCase {
    /// Which tap counts as a link must stay the server guard's own rule, or
    /// the same tap would do different things on the web and in the app.
    /// Compared against the guard's source with whitespace removed (the two
    /// are indented differently).
    func testFindsLinksExactlyAsTheServersNavigationGuardDoes() throws {
        let guardSource = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("../../../../../packages/api/src/artifact/frame-bridge.ts")
            .standardizedFileURL
        let source = try String(contentsOf: guardSource, encoding: .utf8)
        let squash: (String) -> String = { $0.filter { !$0.isWhitespace } }
        let guardScript = try XCTUnwrap(source.range(of: "ARTIFACT_NAVIGATION_GUARD_SCRIPT = `").map { String(source[$0.upperBound...]) })

        for function in ["function eventPath(event)", "function findNavigationLink(event)"] {
            let start = try XCTUnwrap(guardScript.range(of: function), function)
            let end = try XCTUnwrap(guardScript.range(of: "\n  }\n", range: start.upperBound..<guardScript.endIndex), function)
            let body = String(guardScript[start.lowerBound..<end.upperBound])
            XCTAssertTrue(squash(ArtifactLinkBridge.script).contains(squash(body)), "\(function) drifted from the server's guard")
        }
    }

    func testPostsToTheHandlerItsOwnWorldRegisters() {
        XCTAssertTrue(ArtifactLinkBridge.script.contains("window.webkit.messageHandlers.\(ArtifactLinkBridge.handlerName).postMessage(href)"))
        XCTAssertTrue(ArtifactLinkBridge.script.contains("event.isTrusted"), "only a real tap may reach the app")
    }

    func testAcceptsOnlyAStringWithinTheLinkLimit() {
        XCTAssertEqual(ArtifactLinkBridge.acceptedHref(from: "guide"), "guide")
        XCTAssertNil(ArtifactLinkBridge.acceptedHref(from: ""))
        XCTAssertNil(ArtifactLinkBridge.acceptedHref(from: 42))
        XCTAssertNil(ArtifactLinkBridge.acceptedHref(from: ["href": "guide"]))
        XCTAssertNil(ArtifactLinkBridge.acceptedHref(from: String(repeating: "a", count: ArtifactPageLink.maxLength + 1)))
    }
}
