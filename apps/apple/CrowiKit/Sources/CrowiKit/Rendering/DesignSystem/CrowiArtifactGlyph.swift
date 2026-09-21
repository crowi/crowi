import SwiftUI

/// RFC-0020's mark for an HTML artifact page, drawn rather than picked from
/// SF Symbols: the web's icon is three equal rounded squares with the fourth
/// position left empty, and no system symbol has that shape — the nearest
/// ones are four squares or three of unequal size.
///
/// Geometry is the web icon's own, so the two stay the same drawing: a
/// 24-unit box holding 7-unit squares with a 1-unit corner radius and a
/// 2-unit stroke. Takes the colour it is given, like an `Image(systemName:)`
/// would, and carries no accessibility text of its own — the row it sits in
/// owns that.
public struct CrowiArtifactGlyph: View {
    private let size: CGFloat

    public init(size: CGFloat) {
        self.size = size
    }

    public var body: some View {
        CrowiArtifactGlyphShape()
            .stroke(style: StrokeStyle(lineWidth: size * (2 / 24), lineJoin: .round))
            .frame(width: size, height: size)
    }
}

/// Public for the geometry test; nothing outside draws it directly.
public struct CrowiArtifactGlyphShape: Shape {
    /// Top-left, top-right (a unit lower), bottom-left — the web icon's own
    /// offsets, which are what makes it read as a freeform layout rather
    /// than a grid.
    static let squareOrigins = [CGPoint(x: 3, y: 3), CGPoint(x: 14, y: 4), CGPoint(x: 4, y: 14)]

    public init() {}

    public func path(in rect: CGRect) -> Path {
        let unit = min(rect.width, rect.height) / 24
        var path = Path()
        for origin in Self.squareOrigins {
            let square = CGRect(
                x: rect.minX + origin.x * unit,
                y: rect.minY + origin.y * unit,
                width: 7 * unit,
                height: 7 * unit
            )
            path.addRoundedRect(in: square, cornerSize: CGSize(width: unit, height: unit))
        }
        return path
    }
}
