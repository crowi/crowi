import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Compose the App Store icon: the Crowi mark in white, centred on a
// `--primary` gradient. No alpha — the App Store rejects an icon that has
// any, and iOS applies the rounded mask itself, so the artwork must be a
// full-bleed square.
//
// Usage:
//   swift apps/apple/scripts/make-app-icon.swift <mark.png> <out.png>
//   then replace
//   Crowi.swiftpm/Sources/CrowiApp/Resources/Assets.xcassets/AppIcon.appiconset/icon-1024.png
//
// The mark currently ships from
// `crowi-team-heroku/resource/logo/crowi-logo-840.png` (840×840), the
// largest artwork that exists — there is NO vector source anywhere.
// (`docs/website/static/img/crowi-logo-w-200x200.svg` looks like one and is
// not: it is a Sketch export whose only content is a 200×200 PNG embedded
// as a base64 `<image>`.)
//
// The mark is painted through the source's ALPHA rather than drawn: the
// available logos come in both a dark and a white version, and only their
// alpha carries the shape. Masking and filling makes the source's own
// colour irrelevant, so a better logo drops straight in whatever colour it
// arrives in — which is the whole reason this exists as a script instead
// of a one-off.

let src = CommandLine.arguments[1]
let dst = CommandLine.arguments[2]
let size = 1024
// The mark occupies this fraction of the canvas. iOS crops the corners
// with its own superellipse, so a glyph that runs edge to edge loses its
// extremities; ~60% is where Apple's own icons sit.
let markFraction: CGFloat = 0.58

// Draw in a NAMED sRGB space, and build the gradient's colours IN it —
// `CGColor(red:green:blue:alpha:)` makes a device-RGB colour whatever space the
// gradient is given, and converting that into the sRGB-tagged PNG lands every
// value lighter than it was written. Both halves are needed for the two
// constants below to be the icon's actual colour.
let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!


guard
    let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: src) as CFURL, nil),
    let mark = CGImageSourceCreateImageAtIndex(source, 0, nil)
else {
    FileHandle.standardError.write(Data("cannot read \(src)\n".utf8))
    exit(1)
}

guard
    let ctx = CGContext(
        data: nil,
        width: size,
        height: size,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        // noneSkipLast = opaque. An icon with an alpha channel is rejected.
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    )
else {
    FileHandle.standardError.write(Data("cannot create context\n".utf8))
    exit(1)
}

// A vertical ramp from `CrowiTheme.primary` (#3E615F — the app's own teal,
// `--primary` / `oklch(0.465 0.04 192)`) at the bottom to #5285a8 at the top,
// which is what makes a flat square read as a lit object rather than a swatch.
//
// The hue moves here, not just the lightness: #5285a8 is bluer than the app's
// teal. The constraint that does bind is the MARK — it is white, so the top
// end sets the worst case. #5285a8 carries white at 3.98:1, which is fine for
// a 1024pt glyph (large-text territory) and is the reason not to lighten that
// end further.
let top = (r: 0x52 / 255.0, g: 0x85 / 255.0, b: 0xA8 / 255.0)
let bottom = (r: 0x3E / 255.0, g: 0x61 / 255.0, b: 0x5F / 255.0)
guard
    let gradient = CGGradient(
        colorsSpace: colorSpace,
        // Ordered from the gradient's START, which is the BOTTOM edge below
        // — CoreGraphics' origin is bottom-left, so the dark end comes
        // first and the light end last.
        colors: [
            CGColor(colorSpace: colorSpace, components: [bottom.r, bottom.g, bottom.b, 1])!,
            CGColor(colorSpace: colorSpace, components: [top.r, top.g, top.b, 1])!,
        ] as CFArray,
        locations: [0, 1]
    )
else {
    FileHandle.standardError.write(Data("cannot create gradient\n".utf8))
    exit(1)
}
// CoreGraphics' origin is bottom-left, so the END point is the top edge.
ctx.drawLinearGradient(
    gradient,
    start: CGPoint(x: 0, y: 0),
    end: CGPoint(x: 0, y: size),
    options: []
)

let side = CGFloat(size) * markFraction
let origin = (CGFloat(size) - side) / 2
let markRect = CGRect(x: origin, y: origin, width: side, height: side)

ctx.interpolationQuality = .high
ctx.saveGState()
// The source's alpha becomes the stencil; the fill supplies the colour.
ctx.clip(to: markRect, mask: mark)
ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
ctx.fill(markRect)
ctx.restoreGState()

guard
    let image = ctx.makeImage(),
    let destination = CGImageDestinationCreateWithURL(
        URL(fileURLWithPath: dst) as CFURL,
        UTType.png.identifier as CFString,
        1,
        nil
    )
else {
    FileHandle.standardError.write(Data("cannot write \(dst)\n".utf8))
    exit(1)
}
CGImageDestinationAddImage(destination, image, nil)
guard CGImageDestinationFinalize(destination) else {
    FileHandle.standardError.write(Data("finalize failed\n".utf8))
    exit(1)
}
print("wrote \(dst) from \(mark.width)x\(mark.height) source")
