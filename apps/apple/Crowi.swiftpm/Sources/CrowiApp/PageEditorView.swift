import CrowiKit
import SwiftUI

/// RFC-0016 §8 / `feature-ios-phase2-write` — the quick-edit editor,
/// presented as a sheet from `PageReaderView`. On appear it ALWAYS runs a
/// fresh detail `GET` (never trusts the reader's on-screen state, which may
/// be the cached cold-start fast-path) and seeds a `PageEditSession` from
/// it — the client-enforced optimistic lock whose `save()` is the app's
/// sole `PUT /pages` construction path.
///
/// Conflict UX (`crowi edit`'s stance): a `409` re-fetches the current
/// revision and forces an explicit choice — "Discard" (the DEFAULT — the
/// alert's preferred action) or "Re-apply", which swaps the lock base to
/// the latest revision while KEEPING the edited text for an explicit second
/// save. Silent overwrite is impossible by construction.
struct PageEditorView: View {
    let session: WorkspaceSession
    let pagePath: String
    /// Called with the page the reader should show from now on — already
    /// upserted into the read cache here, so the reader needs no refetch.
    /// That is the saved page after a successful save, and after DISCARDING
    /// a conflict it is the other person's newer revision (whose version the
    /// discard just chose). Not called when the editor closes with nothing
    /// resolved (Cancel, or a conflict whose re-fetch was unusable) — the
    /// reader's `onDismiss` re-sync covers those.
    let onLatestPage: (PageLenient) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var editSession: PageEditSession?
    @State private var bodyText = ""
    @State private var isLoading = true
    @State private var isSaving = false
    @State private var showConflictAlert = false
    @State private var conflictLatest: PageLenient?
    @State private var saveErrorMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                if editSession != nil {
                    // The `TextEditor` MUST sit inside a scrollable container
                    // (here a `Form`) with an explicit `minHeight`, exactly
                    // like `PageCreateView`'s body field. A bare `TextEditor`
                    // as the direct child of this `Group` expands to fill the
                    // sheet, and the keyboard's safe-area shrink does not
                    // reach it — so with the keyboard up its bottom sits
                    // BEHIND the keyboard, and because a short body leaves
                    // the editor's own scroll extent at zero, trying to
                    // scroll down there only bounces back (reported
                    // 2026-07-24: 「editor の最下部が画面外に行ってしまう」).
                    // The `Form`'s collection view adjusts its content inset
                    // for the keyboard, which is what makes the bottom of the
                    // editor reachable at all.
                    Form {
                        Section {
                            TextEditor(text: $bodyText)
                                .font(.body.monospaced())
                                .autocorrectionDisabled()
                                .frame(minHeight: 420)
                        }
                    }
                } else if isLoading {
                    ProgressView()
                } else {
                    ContentUnavailableView("Couldn't open this page for editing", systemImage: "exclamationmark.triangle")
                }
            }
            .navigationTitle(pagePath)
            #if canImport(UIKit)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task { await save() }
                    }
                    .disabled(editSession == nil || isSaving)
                }
            }
        }
        .interactiveDismissDisabled(isSaving)
        .task { await prepare() }
        .alert("This page was updated", isPresented: $showConflictAlert) {
            // Discard is the DEFAULT (`.keyboardShortcut(.defaultAction)`
            // marks it as the alert's preferred/bold action) — mirroring the
            // CLI's abort-by-default conflict stance. No cancel button: the
            // conflict must be resolved explicitly, one way or the other.
            Button("Discard My Changes", role: .destructive) {
                // Discarding chose THEIR version, so hand it to the reader.
                // `discardConflict()` returns the revision the 409 branch
                // already re-fetched, so this is free — and without it the
                // reader would sit on the stale pre-edit body it painted
                // before the sheet opened.
                if let latest = editSession?.discardConflict() {
                    CachedPage.upsert(from: latest, in: session.modelContext)
                    onLatestPage(latest)
                }
                dismiss()
            }
            .keyboardShortcut(.defaultAction)
            if conflictLatest?.revision?.id != nil {
                Button("Re-apply onto the Latest Version") {
                    editSession?.reapplyOnLatest()
                }
            }
        } message: {
            Text(
                "Someone saved a newer version of this page while you were editing. Discarding keeps their version. Re-applying keeps your text in the editor, based on their version — nothing is saved until you tap Save again."
            )
        }
        .alert("Couldn't save", isPresented: saveErrorBinding) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(saveErrorMessage ?? "Try again. Your edits are still in the editor.")
        }
    }

    private var saveErrorBinding: Binding<Bool> {
        Binding(get: { saveErrorMessage != nil }, set: { if !$0 { saveErrorMessage = nil } })
    }

    /// §8's hard rule: the lock base + seed body come from a FRESH detail
    /// `GET` at edit start (a list/cached row's bare-string revision can
    /// never seed a lock — `PageEditSession.init?` enforces it).
    private func prepare() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let detail = try await GetPageResponseLenient.fetch(path: pagePath, using: session.apiClient)
            guard let newSession = PageEditSession(detail: detail, client: session.apiClient) else { return }
            editSession = newSession
            bodyText = newSession.seedBody
        } catch {
            // `editSession` stays nil with `isLoading` settling false — the
            // body's "couldn't open" state renders off exactly that.
        }
    }

    private func save() async {
        guard let editSession else { return }
        // An unresolved conflict re-presents its alert instead of saving —
        // `PageEditSession.save` refuses to run over a pending conflict.
        if case .conflict = editSession.state {
            showConflictAlert = true
            return
        }
        isSaving = true
        defer { isSaving = false }
        do {
            let outcome = try await editSession.save(body: bodyText)
            switch outcome {
            case .saved(let page):
                CachedPage.upsert(from: page, in: session.modelContext)
                onLatestPage(page)
                dismiss()
            case .conflict(let latest):
                conflictLatest = latest
                showConflictAlert = true
            case .failed(let message):
                saveErrorMessage = message ?? "Try again. Your edits are still in the editor."
            }
        } catch is URLError {
            // §7.4 offline fail-fast: keep the editor state, manual retry —
            // this also covers a connectivity loss during the conflict
            // re-fetch (`save` throws instead of degrading to a
            // discard-only conflict; retrying replays the whole attempt).
            saveErrorMessage = "Couldn't reach the server. Your edits are still in the editor — try again."
        } catch {
            // Answered-but-unreadable (e.g. an undecodable success body) —
            // keep the editor state too, but don't claim connectivity.
            saveErrorMessage = "The server's response couldn't be read. Your edits are still in the editor — try again."
        }
    }
}
