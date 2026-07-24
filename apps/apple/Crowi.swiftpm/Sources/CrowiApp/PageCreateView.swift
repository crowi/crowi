import CrowiKit
import SwiftUI

/// RFC-0016 §8 / `feature-ios-phase2-write` — the create-page form: path
/// input (seeded from the origin the user came from, so creating from
/// inside `/team/eng/` starts there), grant picker (`PageGrantOption` —
/// structurally valid values only), and a plain body editor (task
/// openQuestion resolved: v1 keeps the editor deliberately simple; design
/// polish is a later phase's concern). Every `PageCreateOutcome` branch
/// gets its own alert wording — the spec's "4 種の 400 を個別 UX で受ける".
struct PageCreateView: View {
    let session: WorkspaceSession
    let originPath: String
    let onSelectDestination: (ReadDestination) -> Void

    @State private var path: String
    @State private var bodyText = ""
    @State private var grant: PageGrantOption = .publicPage
    @State private var isCreating = false
    @State private var presentedOutcome: PageCreateOutcome?
    @State private var showTransportError = false

    init(session: WorkspaceSession, originPath: String, onSelectDestination: @escaping (ReadDestination) -> Void) {
        self.session = session
        self.originPath = originPath
        self.onSelectDestination = onSelectDestination
        _path = State(initialValue: Self.seededPath(fromOrigin: originPath))
    }

    var body: some View {
        Form {
            Section("Path") {
                TextField("/path/to/page", text: $path)
                    .autocorrectionDisabled()
                    #if canImport(UIKit)
                    .textInputAutocapitalization(.never)
                    #endif
                    .font(.body.monospaced())
            }
            Section("Visibility") {
                Picker("Visibility", selection: $grant) {
                    ForEach(PageGrantOption.allCases) { option in
                        Text(option.displayName).tag(option)
                    }
                }
            }
            Section("Body") {
                TextEditor(text: $bodyText)
                    .font(.body.monospaced())
                    .frame(minHeight: 240)
            }
        }
        .navigationTitle("New Page")
        #if canImport(UIKit)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Create") {
                    Task { await create() }
                }
                .disabled(isCreating || !isPathPlausible)
            }
        }
        .overlay {
            if isCreating {
                ProgressView()
            }
        }
        .alert(outcomeTitle, isPresented: outcomeAlertBinding, presenting: presentedOutcome) { outcome in
            outcomeActions(for: outcome)
        } message: { outcome in
            Text(Self.outcomeMessage(for: outcome))
        }
        // §7.4 offline fail-fast: a transport failure keeps the whole form
        // state in memory and just tells the user to retry manually — no
        // offline queue, no background retry.
        .alert("Couldn't reach the server", isPresented: $showTransportError) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Check your connection and try Create again. Your draft stays right here.")
        }
    }

    /// A creatable path needs at least one segment beyond the leading `/`.
    private var isPathPlausible: Bool {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed != "/"
    }

    private func create() async {
        isCreating = true
        defer { isCreating = false }
        do {
            let outcome = try await PageCreateFlow(client: session.apiClient).create(path: path, body: bodyText, grant: grant)
            if case .created(let page) = outcome {
                // The success envelope IS the detail shape — upsert the read
                // cache and open the new page without a refetch.
                CachedPage.upsert(from: page, in: session.modelContext)
                onSelectDestination(.page(path: page.path))
                return
            }
            presentedOutcome = outcome
        } catch is URLError {
            // Connectivity (offline/DNS/timeout) — the §7.4 retry alert.
            showTransportError = true
        } catch {
            // The server DID answer but the response couldn't be understood
            // (e.g. an undecodable success/follow-up body) — a generic
            // failure, never the connectivity message.
            presentedOutcome = .createFailed(message: "The server's response couldn't be read. Please try again.")
        }
    }

    // MARK: - Outcome presentation

    private var outcomeAlertBinding: Binding<Bool> {
        Binding(get: { presentedOutcome != nil }, set: { if !$0 { presentedOutcome = nil } })
    }

    private var outcomeTitle: String {
        switch presentedOutcome {
        case .pageExists: return "A page already exists here"
        case .pathTaken: return "That path is taken"
        case .twinExists: return "A twin page exists"
        case .nonExistentUserPage: return "No such user page"
        default: return "Couldn't create the page"
        }
    }

    @ViewBuilder
    private func outcomeActions(for outcome: PageCreateOutcome) -> some View {
        switch outcome {
        case .pageExists(let existing):
            // The follow-up open already CONFIRMED this page is readable —
            // "Open" lands on the reader, whose own Edit button is the
            // "edit instead" affordance.
            Button("Open Existing Page") { onSelectDestination(.page(path: existing.path)) }
            Button("Keep Editing", role: .cancel) {}
        case .twinExists(let twinPath):
            Button("Open \(twinPath)") { onSelectDestination(.page(path: twinPath)) }
            Button("Keep Editing", role: .cancel) {}
        default:
            Button("OK", role: .cancel) {}
        }
    }

    private static func outcomeMessage(for outcome: PageCreateOutcome) -> String {
        switch outcome {
        case .created:
            return "" // handled before presentation — never alerts
        case .pageExists:
            return "You can open the existing page (and edit it from there), or choose another path."
        case .pathTaken:
            // The PAGE_EXISTS grant-secrecy collapse: the follow-up open was
            // denied, so never promise the page is openable.
            return "That path is already in use. Choose another path."
        case .twinExists(let twinPath):
            return "A page with the opposite trailing slash already exists at \(twinPath)."
        case .nonExistentUserPage:
            return "Pages under /user/... can only be created for users that exist on this workspace."
        case .createFailed(let message):
            return message ?? "Something went wrong creating this page."
        }
    }

    /// Seed the path input with the origin directory, trailing-slashed so
    /// the user just appends a page name (`/team/eng/` → type `weekly`).
    private static func seededPath(fromOrigin origin: String) -> String {
        let trimmed = origin.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != "/" else { return "/" }
        return trimmed.hasSuffix("/") ? trimmed : trimmed + "/"
    }
}
