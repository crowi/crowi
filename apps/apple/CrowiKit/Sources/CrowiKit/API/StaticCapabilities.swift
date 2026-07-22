/// Mirrors `packages/api-contract/src/schemas/app-capabilities.ts:STATIC_CAPABILITIES`
/// — the always-on baseline a workspace degrades to when `/app/info` omits
/// `capabilities` entirely (an old host, §5.2 / §3 add-flow step 2). Kept as
/// a plain `[String]` (not an enum) deliberately: the whole point of the
/// lenient decoder is to tolerate a vocabulary a build doesn't know about
/// yet, so this list is a reference baseline to *substitute*, not a closed
/// `Capability` enum to validate incoming tags against.
public enum StaticCapabilities {
    public static let baseline: [String] = [
        "oauth",
        "oauth:auth-code",
        "oauth:device",
        "oauth:pkce",
        "pat",
        "pages",
        "comments",
        "bookmarks",
        "attachments",
        "notifications",
    ]
}
