import CrowiKit
import SwiftUI

/// RFC-0016 §9 — the hierarchy/portal/children sidebar: the `NavigationSplitView`
/// sidebar column on iPad/regular width, and the root of the `NavigationStack`
/// on iPhone/compact width (§9 §10.2 read spec). Drills into a sub-directory
/// by pushing another `PageTreeView` for that segment's path (simpler and
/// more robust across both size classes than an in-place expandable outline
/// for a lazily-paginated, one-level-at-a-time server API).
struct PageTreeView: View {
    let session: WorkspaceSession
    let path: String
    /// Whether `path` ITSELF (not its children) has a real portal page saved
    /// at it (`PageChildSegment.hasPortal` for the segment being drilled
    /// into) — surfaces a toolbar action to open that page's OWN body,
    /// since drilling in here only ever lists children, and a segment can be
    /// BOTH a portal document and a directory of further pages at once
    /// (§9 — a portal-with-children segment must not lose its own body
    /// behind an always-drill-down affordance). Defaults to `true` for the
    /// root ("/"): a Crowi instance's home page is itself almost always a
    /// real portal document, and if it happens not to be, the reader falls
    /// back to its own graceful "couldn't load this page" state (no crash).
    var hasPortal = true
    /// `RootScene`-style callback: `WorkspaceHomeView` decides what
    /// "select" means per size class (push on iPhone, set the split-view
    /// detail selection on iPad).
    let onSelect: (ReadDestination) -> Void

    @State private var children: [PageChildSegmentLenient] = []
    @State private var isLoading = false
    @State private var loadErrorMessage: String?

    var body: some View {
        List(children, id: \.path) { child in
            row(for: child)
        }
        .overlay {
            if isLoading, children.isEmpty {
                ProgressView()
            } else if children.isEmpty, let loadErrorMessage {
                ContentUnavailableView(loadErrorMessage, systemImage: "exclamationmark.triangle")
            } else if children.isEmpty {
                ContentUnavailableView("No pages here yet", systemImage: "doc.text")
            }
        }
        .navigationTitle(path == "/" ? "Pages" : path)
        .toolbar {
            if hasPortal {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        // The portal document's own saved path IS `path`
                        // (trailing-slashed, e.g. `/crowi/rfc/`) — unlike a
                        // leaf page below, never dropped: a portal's page
                        // row in `pages` is stored WITH the trailing slash.
                        onSelect(.page(path: path))
                    } label: {
                        Label("View Portal Page", systemImage: "doc.text")
                    }
                }
            }
        }
        .task(id: path) { await load() }
        .refreshable { await load() }
    }

    @ViewBuilder
    private func row(for child: PageChildSegmentLenient) -> some View {
        // A directory-like segment (a portal doc, or descendants exist)
        // drills further; a pure leaf page opens directly. A segment that
        // is BOTH a portal document AND a directory (`hasPortal && count >
        // 0`) still drills down as its primary action, but carries its own
        // toolbar affordance (above, once pushed) to open the portal body
        // itself — so neither the children nor the portal's own content is
        // ever unreachable.
        if child.hasPortal || child.count > 0 {
            NavigationLink {
                PageTreeView(session: session, path: child.path, hasPortal: child.hasPortal, onSelect: onSelect)
            } label: {
                label(for: child, systemImage: child.hasPortal ? "folder.fill" : "folder")
            }
        } else if child.isPage {
            Button {
                onSelect(.page(path: String(child.path.dropLast())))
            } label: {
                label(for: child, systemImage: "doc.text")
            }
            .buttonStyle(.plain)
        } else {
            label(for: child, systemImage: "questionmark.folder")
        }
    }

    private func label(for child: PageChildSegmentLenient, systemImage: String) -> some View {
        Label(child.segment, systemImage: systemImage)
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response = try await ListPageChildrenResponseLenient.fetch(path: path, using: session.apiClient)
            children = response.children
            loadErrorMessage = nil
            CachedPageChildren.upsert(path: path, children: response.children, in: session.modelContext)
        } catch {
            if let cached = CachedPageChildren.cached(path: path, in: session.modelContext), !cached.isEmpty {
                children = cached
            }
            loadErrorMessage = children.isEmpty ? "Couldn't load this workspace's pages." : nil
        }
    }
}
