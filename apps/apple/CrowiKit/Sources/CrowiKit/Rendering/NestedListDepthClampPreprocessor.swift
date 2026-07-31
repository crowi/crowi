import Foundation

/// Clamps markdown list nesting to `maxDepth` levels BEFORE the body reaches
/// MarkdownUI: items nested deeper are re-indented to sit as depth-`maxDepth`
/// siblings (content preserved, hierarchy visually truncated).
///
/// WHY: MarkdownUI lays nested lists out with one stack level per list
/// level, and SwiftUI's StackLayout sizing explodes ~×15 per nesting level
/// (measured on the real failing page's shape: depth 3 → 140ms, 4 → 906ms,
/// 5 → 15.0s, 6+ → >25s — a permanent main-thread wedge on first paint).
/// This raw-body path runs on every cache re-open (`CachedPage.asPageLenient`
/// deliberately pins `renderedAst: nil`) and as the fallback when no typed
/// envelope arrived, so an 8-level bullet page froze the app even when the
/// AST path would later have taken over. The AST path itself has NO such
/// clamp — `RenderedAstListFlattener` renders lists flat (constant stack
/// nesting at any depth), so deep documents keep full hierarchy there.
///
/// Scope and deliberate limits:
///   - only LIST-ITEM lines (`- ` / `* ` / `+ ` / `1. ` / `1) `) outside
///     fenced code are ever re-indented; everything else passes through
///     byte-identically, and a body that needs no clamping is returned as
///     the same string instance;
///   - depth accounting is a pragmatic indent-column stack, not a full
///     CommonMark list parser: it deliberately errs toward UNDER-counting
///     (e.g. the stack resets on a flush-left paragraph), because a missed
///     clamp degrades to slower layout while a wrong clamp would corrupt a
///     document's structure;
///   - indented lines directly under a clamped item (its continuation
///     paragraphs / nested content) shift left by the same amount so they
///     stay attached to the item instead of turning into indented code;
///   - a list-shaped line with ≥4 columns of indent when NO list is open is
///     a CommonMark indented code block, never touched.
public enum NestedListDepthClampPreprocessor {
    /// Deepest list level allowed through to MarkdownUI. Depth 4 measured
    /// ~0.9s on the failing page's shape — the last tolerable level before
    /// the ×15 explosion (depth 5 already took 15s).
    public static let maxDepth = 4

    public static func clamp(_ body: String) -> String {
        var outputLines: [Substring] = []
        var didRewrite = false
        /// Indent columns of the currently-open list levels (`stack.count`
        /// == current nesting depth).
        var indentStack: [Int] = []
        var fenceDelimiter: Character?
        /// Set after clamping an item: continuation lines indented past the
        /// item's ORIGINAL indent shift left by the same `delta`.
        var activeShift: (originalIndent: Int, delta: Int)?

        for line in body.split(separator: "\n", omittingEmptySubsequences: false) {
            if let delimiter = fenceDelimiter {
                outputLines.append(line)
                if isFenceLine(line, delimiter: delimiter) { fenceDelimiter = nil }
                continue
            }
            if let opened = openingFenceDelimiter(line) {
                fenceDelimiter = opened
                activeShift = nil
                outputLines.append(line)
                continue
            }
            if line.allSatisfy({ $0 == " " || $0 == "\t" }) {
                // Blank line — lists survive it (loose lists); pass through.
                outputLines.append(line)
                continue
            }

            let (indent, contentStart) = leadingIndent(of: line)

            guard isListItemLine(line, contentStart: contentStart) else {
                if let shift = activeShift, indent > shift.originalIndent {
                    // Continuation content of a clamped item — keep it
                    // attached by shifting it the same distance left.
                    let newIndent = max(indent - shift.delta, 0)
                    outputLines.append(Substring(String(repeating: " ", count: newIndent) + line[contentStart...]))
                    didRewrite = true
                    continue
                }
                activeShift = nil
                if indent == 0 {
                    // A flush-left non-list block interrupts the list
                    // context (conservative: under-counting depth is safe).
                    indentStack.removeAll()
                }
                outputLines.append(line)
                continue
            }

            activeShift = nil
            if indentStack.isEmpty && indent >= 4 {
                // Indented code block, not a list item.
                outputLines.append(line)
                continue
            }
            while let last = indentStack.last, last >= indent {
                indentStack.removeLast()
            }
            if indentStack.count >= maxDepth {
                // This item would open depth maxDepth+1 (or deeper): re-seat
                // it as a SIBLING of the depth-maxDepth ancestor.
                let target = indentStack[maxDepth - 1]
                while let last = indentStack.last, last >= target {
                    indentStack.removeLast()
                }
                indentStack.append(target)
                outputLines.append(Substring(String(repeating: " ", count: target) + line[contentStart...]))
                didRewrite = true
                activeShift = (originalIndent: indent, delta: indent - target)
            } else {
                indentStack.append(indent)
                outputLines.append(line)
            }
        }

        guard didRewrite else { return body }
        return outputLines.joined(separator: "\n")
    }

    /// Leading whitespace in columns (tab advances to the next 4-column tab
    /// stop, CommonMark's rule) plus the index where content starts.
    private static func leadingIndent(of line: Substring) -> (columns: Int, contentStart: Substring.Index) {
        var columns = 0
        var index = line.startIndex
        while index < line.endIndex {
            switch line[index] {
            case " ": columns += 1
            case "\t": columns += 4 - (columns % 4)
            default: return (columns, index)
            }
            index = line.index(after: index)
        }
        return (columns, index)
    }

    /// `-` / `*` / `+` or a 1-9-digit ordered marker (`12.` / `12)`), each
    /// followed by whitespace or end of line — cmark's list-item shapes.
    private static func isListItemLine(_ line: Substring, contentStart: Substring.Index) -> Bool {
        let rest = line[contentStart...]
        guard let first = rest.first else { return false }
        if first == "-" || first == "*" || first == "+" {
            let after = rest.index(after: rest.startIndex)
            return after == rest.endIndex || rest[after] == " " || rest[after] == "\t"
        }
        guard first.isASCII, first.isNumber else { return false }
        var index = rest.startIndex
        var digits = 0
        while index < rest.endIndex, rest[index].isASCII, rest[index].isNumber {
            digits += 1
            if digits > 9 { return false }
            index = rest.index(after: index)
        }
        guard index < rest.endIndex, rest[index] == "." || rest[index] == ")" else { return false }
        let after = rest.index(after: index)
        return after == rest.endIndex || rest[after] == " " || rest[after] == "\t"
    }

    /// A ``` / ~~~ fence opener (any indent — fences nest inside list items).
    private static func openingFenceDelimiter(_ line: Substring) -> Character? {
        let trimmed = line.drop(while: { $0 == " " || $0 == "\t" })
        if trimmed.hasPrefix("```") { return "`" }
        if trimmed.hasPrefix("~~~") { return "~" }
        return nil
    }

    /// A CLOSING fence: 3+ of the opening delimiter and nothing but
    /// whitespace after (an info string would make it a nested opener, e.g.
    /// ````` ````swift ````` inside a ``` block — not a close).
    private static func isFenceLine(_ line: Substring, delimiter: Character) -> Bool {
        let trimmed = line.drop(while: { $0 == " " || $0 == "\t" })
        let run = trimmed.prefix(while: { $0 == delimiter })
        guard run.count >= 3 else { return false }
        return trimmed.dropFirst(run.count).allSatisfy { $0 == " " || $0 == "\t" }
    }
}
