import CrowiKit
import QuickLook
import SwiftUI

/// A non-image attachment, shown with the system's own previewer.
///
/// The web opens a modal for these; tapping one here used to land on
/// "Couldn't load this page", because an attachment URL is same-origin and
/// so classified as a page path — the reader went looking for a page called
/// `/api/attachments/<id>`.
///
/// QuickLook reads a FILE, and decides what it is looking at from the
/// extension, so the bytes are written under the name they were uploaded
/// with. They are fetched through the workspace's authenticated loader for
/// the same reason every other embed is: these endpoints are Bearer-gated,
/// and handing the URL to the system browser would meet a 401.
struct AttachmentPreviewView: View {
    let session: WorkspaceSession
    let attachmentId: String

    @Environment(\.dismiss) private var dismiss
    @State private var fileURL: URL?
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            Group {
                if let fileURL {
                    QuickLookView(url: fileURL)
                } else if let failure {
                    ContentUnavailableView(failure, systemImage: "doc.questionmark")
                } else {
                    ProgressView()
                }
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task(id: attachmentId) { await load() }
    }

    private func load() async {
        do {
            let meta = try await AttachmentMetaLenient.fetch(attachmentId: attachmentId, using: session.apiClient)
            // The original bytes, not the display derivative: a derivative
            // exists only for images, and this path is for everything else.
            let source = meta.originalUrl ?? meta.url ?? "/api/attachments/\(attachmentId)"
            let data = try await session.imageCache.fetch(source)
            fileURL = try write(data, named: meta.originalName ?? attachmentId)
        } catch {
            failure = "Couldn't open this attachment."
        }
    }

    /// A per-attachment directory, so two files uploaded under the same name
    /// cannot overwrite each other while both are on screen.
    private func write(_ data: Data, named name: String) throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("attachments", isDirectory: true)
            .appendingPathComponent(attachmentId, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(name.isEmpty ? attachmentId : name)
        try data.write(to: url, options: .atomic)
        return url
    }
}

private struct QuickLookView: UIViewControllerRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        context.coordinator.url = url
        controller.reloadData()
    }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var url: URL

        init(url: URL) { self.url = url }

        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
            url as NSURL
        }
    }
}
