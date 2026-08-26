/// Display label for a raw page grant number (`PageGrantEnum`: 1 public /
/// 2 restricted / 3 specified / 4 owner). Separate from `PageGrantOption`
/// (the create/edit picker), which deliberately omits `specified` — history
/// is read-only display and must be able to show every grant a page has
/// ever actually had, including one the picker itself cannot set.
public enum PageGrantLabel {
    public static func label(for grant: Int?) -> String {
        switch grant {
        case 1: return "Public"
        case 2: return "Restricted"
        case 3: return "Specified users"
        case 4: return "Owner only"
        default: return "Unknown"
        }
    }
}
