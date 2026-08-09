import SwiftUI

/// The deterministic default avatar the web shows for a user with no picture
/// (`boring-avatars`, `variant="beam"`), ported so the same person wears the
/// same face on both clients.
///
/// A port rather than a fresh design: the seed, the palette and every derived
/// number have to match the web exactly, or one person is two different faces
/// depending on which client you opened. The parity is pinned by a shared
/// fixture both suites read
/// (`packages/web/src/components/__fixtures__/beam-avatar-corpus.json`).
public struct CrowiBeamAvatarData: Equatable, Sendable {
    public let wrapperColorHex: String
    public let faceColorHex: String
    public let backgroundColorHex: String
    public let wrapperTranslateX: Double
    public let wrapperTranslateY: Double
    public let wrapperRotate: Double
    public let wrapperScale: Double
    public let isMouthOpen: Bool
    public let isCircle: Bool
    public let eyeSpread: Double
    public let mouthSpread: Double
    public let faceRotate: Double
    public let faceTranslateX: Double
    public let faceTranslateY: Double
}

public enum CrowiBeamAvatar {
    /// The design's own palette, as the web passes it to `boring-avatars`.
    public static let colors = ["#43676b", "#8eb39b", "#f0d264", "#e89a4d", "#d96d68"]

    /// The drawing's coordinate space. Every constant below is in it.
    public static let size: Double = 36

    /// The seed hash.
    ///
    /// JavaScript's `<<` and `&` operate on 32-bit SIGNED integers, so the
    /// accumulator wraps there and this must wrap identically — a plain `Int`
    /// would keep 64 bits, never overflow, and produce a different (equally
    /// plausible-looking) face for every name. `&*` / `&-` are the wrapping
    /// operators; `Int32.min` is negated explicitly because its magnitude has
    /// no positive `Int32`.
    public static func hash(_ name: String) -> Int {
        var result: Int32 = 0
        for scalar in name.utf16 {
            result = (result << 5) &- result &+ Int32(scalar)
        }
        return result == Int32.min ? Int(Int32.max) + 1 : Int(abs(result))
    }

    static func digit(_ n: Int, _ place: Int) -> Int {
        Int((Double(n) / pow(10, Double(place))).rounded(.down)) % 10
    }

    static func isEvenDigit(_ n: Int, _ place: Int) -> Bool {
        digit(n, place) % 2 == 0
    }

    /// `range`-bounded value, negated when digit `place` is even. `place: nil`
    /// is the always-positive form (JS passes no index).
    static func unit(_ n: Int, _ range: Int, _ place: Int? = nil) -> Double {
        let value = Double(n % range)
        guard let place, digit(n, place) % 2 == 0 else { return value }
        return -value
    }

    static func pick(_ n: Int, _ colors: [String]) -> String {
        colors[n % colors.count]
    }

    /// Black or white, whichever reads on `hex` — the same luminance split the
    /// library uses for the face.
    static func contrastHex(_ hex: String) -> String {
        var value = hex
        if value.hasPrefix("#") { value.removeFirst() }
        let bytes = stride(from: 0, to: min(6, value.count), by: 2).map { offset -> Double in
            let start = value.index(value.startIndex, offsetBy: offset)
            let end = value.index(start, offsetBy: 2)
            return Double(Int(value[start..<end], radix: 16) ?? 0)
        }
        guard bytes.count == 3 else { return "#FFFFFF" }
        return (bytes[0] * 299 + bytes[1] * 587 + bytes[2] * 114) / 1000 >= 128 ? "#000000" : "#FFFFFF"
    }

    public static func data(for name: String, colors: [String] = colors) -> CrowiBeamAvatarData {
        let n = hash(name)
        let wrapperColor = pick(n, colors)
        let preX = unit(n, 10, 1)
        let translateX = preX < 5 ? preX + size / 9 : preX
        let preY = unit(n, 10, 2)
        let translateY = preY < 5 ? preY + size / 9 : preY
        return CrowiBeamAvatarData(
            wrapperColorHex: wrapperColor,
            faceColorHex: contrastHex(wrapperColor),
            backgroundColorHex: pick(n + 13, colors),
            wrapperTranslateX: translateX,
            wrapperTranslateY: translateY,
            wrapperRotate: unit(n, 360),
            wrapperScale: 1 + unit(n, Int(size / 12)) / 10,
            isMouthOpen: isEvenDigit(n, 2),
            isCircle: isEvenDigit(n, 1),
            eyeSpread: unit(n, 5),
            mouthSpread: unit(n, 3),
            faceRotate: unit(n, 10, 3),
            faceTranslateX: translateX > size / 6 ? translateX / 2 : unit(n, 8, 1),
            faceTranslateY: translateY > size / 6 ? translateY / 2 : unit(n, 7, 2)
        )
    }
}

/// The beam avatar, drawn with shapes rather than rasterized from SVG: the
/// library's output is a background, one rounded rect and three face marks,
/// all of which SwiftUI draws directly.
public struct CrowiBeamAvatarView: View {
    private let name: String
    private let diameter: CGFloat

    public init(name: String, diameter: CGFloat) {
        self.name = name
        self.diameter = diameter
    }

    public var body: some View {
        let data = CrowiBeamAvatar.data(for: name)
        let scale = diameter / CrowiBeamAvatar.size
        let face = Color(hex: data.faceColorHex)

        return ZStack {
            Color(hex: data.backgroundColorHex)
            RoundedRectangle(
                cornerRadius: data.isCircle ? CrowiBeamAvatar.size : CrowiBeamAvatar.size / 6,
                style: .circular
            )
            .fill(Color(hex: data.wrapperColorHex))
            .frame(width: CrowiBeamAvatar.size, height: CrowiBeamAvatar.size)
            // SVG's `scale()` grows a shape away from the ORIGIN, so an
            // oversized wrapper drifts down-right; SwiftUI's default centre
            // anchor would grow it evenly and leave the face sitting off it.
            .scaleEffect(data.wrapperScale, anchor: .topLeading)
            .rotationEffect(.degrees(data.wrapperRotate))
            .offset(x: data.wrapperTranslateX, y: data.wrapperTranslateY)

            faceMarks(data, face: face)
                .rotationEffect(.degrees(data.faceRotate))
                .offset(x: data.faceTranslateX, y: data.faceTranslateY)
        }
        .frame(width: CrowiBeamAvatar.size, height: CrowiBeamAvatar.size)
        .scaleEffect(scale)
        .frame(width: diameter, height: diameter)
        .clipShape(Circle())
        // The face is decoration for a name the row already prints.
        .accessibilityHidden(true)
    }

    /// Positions are absolute in the 36×36 space, so the marks are placed by
    /// offsetting from the centre (18, 18) — the library states them as raw
    /// `x`/`y` in that same space.
    private func faceMarks(_ data: CrowiBeamAvatarData, face: Color) -> some View {
        let centre = CrowiBeamAvatar.size / 2
        return ZStack {
            mouth(data)
                .foregroundStyle(face)
            ForEach([14 - data.eyeSpread, 20 + data.eyeSpread], id: \.self) { x in
                RoundedRectangle(cornerRadius: 1, style: .circular)
                    .fill(face)
                    .frame(width: 1.5, height: 2)
                    .offset(x: x + 0.75 - centre, y: 14 + 1 - centre)
            }
        }
    }

    /// Drawn in the 36×36 space directly — a `Path` in a frame of that size
    /// places its absolute coordinates where the library's `d` attribute
    /// puts them.
    @ViewBuilder
    private func mouth(_ data: CrowiBeamAvatarData) -> some View {
        let y = 19 + data.mouthSpread
        if data.isMouthOpen {
            // `M15 y c2 1 4 1 6 0` — a shallow smile stroked, not filled.
            Path { path in
                path.move(to: CGPoint(x: 15, y: y))
                path.addCurve(
                    to: CGPoint(x: 21, y: y),
                    control1: CGPoint(x: 17, y: y + 1),
                    control2: CGPoint(x: 19, y: y + 1)
                )
            }
            .stroke(style: StrokeStyle(lineWidth: 1, lineCap: .round))
            .frame(width: CrowiBeamAvatar.size, height: CrowiBeamAvatar.size)
        } else {
            // `M13,y a1,0.75 0 0,0 10,0` — a filled half-ellipse bulging down.
            //
            // The stated radii are far too small to reach the endpoint, so SVG
            // scales them up until they just do (F.6.6): 1×0.75 becomes 5×3.75,
            // which is the half-ellipse drawn below. Two cubics rather than one
            // quadratic — a quadratic through the same endpoints only reaches
            // two thirds of the depth, and the mouth reads as a different
            // expression at that size.
            let rx: CGFloat = 5
            let ry: CGFloat = 3.75
            let k: CGFloat = 0.5522847498
            Path { path in
                path.move(to: CGPoint(x: 18 - rx, y: y))
                path.addCurve(
                    to: CGPoint(x: 18, y: y + ry),
                    control1: CGPoint(x: 18 - rx, y: y + ry * k),
                    control2: CGPoint(x: 18 - rx * k, y: y + ry)
                )
                path.addCurve(
                    to: CGPoint(x: 18 + rx, y: y),
                    control1: CGPoint(x: 18 + rx * k, y: y + ry),
                    control2: CGPoint(x: 18 + rx, y: y + ry * k)
                )
                path.closeSubpath()
            }
            .frame(width: CrowiBeamAvatar.size, height: CrowiBeamAvatar.size)
        }
    }
}

extension Color {
    /// `#RRGGBB` only — every value here comes from the fixed palette or from
    /// the library's black/white contrast pick.
    init(hex: String) {
        var value = hex
        if value.hasPrefix("#") { value.removeFirst() }
        let number = Int(value, radix: 16) ?? 0
        self.init(
            .sRGB,
            red: Double((number >> 16) & 0xFF) / 255,
            green: Double((number >> 8) & 0xFF) / 255,
            blue: Double(number & 0xFF) / 255,
            opacity: 1
        )
    }
}
