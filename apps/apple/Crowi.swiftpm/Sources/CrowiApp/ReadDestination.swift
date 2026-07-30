import Foundation

/// RFC-0016 §9/feature-ios-phase1-read — every destination the read surface
/// can navigate to, shared by both the compact `NavigationStack` (pushed
/// via `NavigationPath`) and the regular-width `NavigationSplitView`'s
/// detail-selection binding, so there is exactly ONE navigation model for
/// both size classes (RootScene's own "all platform/size-class branching in
/// one place" rule, applied one level down for the read surface itself).
enum ReadDestination: Hashable {
    case page(path: String)
    case search
    case revisionHistory(pageId: String, pagePath: String)
    /// `nil` username = the signed-in user's own profile (`GET /me`).
    case profile(username: String?)
    case recentlyViewed
    /// `feature-ios-phase2-write` — the create-page form. `originPath` is
    /// the location the user was at when they tapped "New Page" (the home's
    /// `/`, or the page tree's current directory path), used to seed the
    /// path input with a relative starting point.
    case createPage(originPath: String)
    /// `feature-ios-phase3-notifications-extensions` — the notifications
    /// list (RFC-0016 §11), opened from the toolbar bell; a row tap then
    /// navigates onward via `.page(path:)`.
    case notifications
}
