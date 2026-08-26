import Foundation

/// A markdown-source line diff between two revision bodies — raw text, line
/// granularity, matching the web's own diff view (`RevisionDiff.tsx` diffs
/// `.body` with `DiffMethod.LINES`, never the rendered AST).
public enum RevisionLineDiffKind: Sendable, Equatable {
    case unchanged
    case added
    case removed
}

public struct RevisionLineDiffRow: Sendable, Equatable, Identifiable {
    public let id: Int
    public let kind: RevisionLineDiffKind
    public let text: String

    public init(id: Int, kind: RevisionLineDiffKind, text: String) {
        self.id = id
        self.kind = kind
        self.text = text
    }
}

public enum RevisionLineDiff {
    /// Reconstructs a unified (GitHub-style) diff from Swift's own
    /// `CollectionDifference`. The two independent position counters
    /// (`oldIndex`/`newIndex`) advance together over every line NEITHER
    /// changeset touches — those are exactly the longest-common-subsequence
    /// lines the diff kept, so at every such step `oldLines[oldIndex]` and
    /// `newLines[newIndex]` are the same line by construction.
    public static func compute(from oldBody: String, to newBody: String) -> [RevisionLineDiffRow] {
        let oldLines = oldBody.components(separatedBy: "\n")
        let newLines = newBody.components(separatedBy: "\n")
        let diff = newLines.difference(from: oldLines)

        var removedAt: [Int: String] = [:]
        var insertedAt: [Int: String] = [:]
        for change in diff {
            switch change {
            case .remove(let offset, let element, _):
                removedAt[offset] = element
            case .insert(let offset, let element, _):
                insertedAt[offset] = element
            }
        }

        var rows: [RevisionLineDiffRow] = []
        var oldIndex = 0
        var newIndex = 0
        while oldIndex < oldLines.count || newIndex < newLines.count {
            if let removed = removedAt[oldIndex] {
                rows.append(RevisionLineDiffRow(id: rows.count, kind: .removed, text: removed))
                oldIndex += 1
            } else if let inserted = insertedAt[newIndex] {
                rows.append(RevisionLineDiffRow(id: rows.count, kind: .added, text: inserted))
                newIndex += 1
            } else if oldIndex < oldLines.count, newIndex < newLines.count {
                rows.append(RevisionLineDiffRow(id: rows.count, kind: .unchanged, text: oldLines[oldIndex]))
                oldIndex += 1
                newIndex += 1
            } else if oldIndex < oldLines.count {
                oldIndex += 1
            } else {
                newIndex += 1
            }
        }
        return rows
    }
}
