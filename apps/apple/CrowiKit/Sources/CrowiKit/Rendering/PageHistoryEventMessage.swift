/// Maps a `PageHistoryEventRowLenient` to its display copy — separated from
/// `CrowiHistoryEventRow` (the view) the same way the web keeps
/// `eventMessage`/`eventDetail` apart from `PageEventRow`'s JSX, so the
/// per-kind copy is a plain, unit-testable function.
public enum PageHistoryEventMessage {
    /// The one-line summary beside the actor's name. `kind` is raw on the
    /// row (never a closed Swift enum) — an unrecognized kind still gets a
    /// generic sentence rather than vanishing from the timeline.
    public static func message(for kind: String) -> String {
        switch kind {
        case "page_created": return "created this page"
        case "page_renamed": return "renamed this page"
        case "visibility_changed": return "changed visibility"
        case "page_trashed": return "moved this page to trash"
        case "page_restored": return "restored this page"
        case "draft_published": return "published the draft"
        default: return "changed this page"
        }
    }

    /// The optional second line — a path change, a trash/restore
    /// destination, or a grant-to-grant transition. `nil` when the kind
    /// carries no extra detail (`page_created`, `draft_published`) or the
    /// payload is missing the fields this kind needs (an older/newer server
    /// disagreement) — the summary line above still stands on its own.
    public static func detail(for row: PageHistoryEventRowLenient) -> CrowiHistoryEventDetail? {
        switch row.kind {
        case "page_renamed":
            guard let fromPath = row.fromPath, let toPath = row.toPath else { return nil }
            return .text("\(fromPath) → \(toPath)", showsRedirectBadge: row.redirectCreated ?? false)
        case "visibility_changed":
            guard let fromGrant = row.fromGrant, let toGrant = row.toGrant else { return nil }
            return .visibility(fromLabel: PageGrantLabel.label(for: fromGrant), toLabel: PageGrantLabel.label(for: toGrant))
        case "page_trashed":
            guard let fromPath = row.fromPath else { return nil }
            return .text("Moved to trash: \(fromPath)", showsRedirectBadge: false)
        case "page_restored":
            guard let toPath = row.toPath else { return nil }
            return .text("Restored to: \(toPath)", showsRedirectBadge: false)
        default:
            return nil
        }
    }
}

public enum CrowiHistoryEventDetail: Sendable, Equatable {
    case text(String, showsRedirectBadge: Bool)
    case visibility(fromLabel: String, toLabel: String)
}
