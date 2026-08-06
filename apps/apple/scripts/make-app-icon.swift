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
        space: CGColorSpaceCreateDeviceRGB(),
        // noneSkipLast = opaque. An icon with an alpha channel is rejected.
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    )
else {
    FileHandle.standardError.write(Data("cannot create context\n".utf8))
    exit(1)
}

// The background is `CrowiTheme.primary` (#3E615F — the same teal the
// initials avatars use), lifted at the top and dropped at the bottom.
// Only LIGHTNESS moves: the hue stays exactly the app's, so the icon still
// reads as the same colour, and a vertical ramp is what makes a flat
// square look like a lit object rather than a swatch.
let top = (r: 0x4E / 255.0, g: 0x79 / 255.0, b: 0x77 / 255.0)
let bottom = (r: 0x2D / 255.0, g: 0x46 / 255.0, b: 0x44 / 255.0)
guard
    let gradient = CGGradient(
        colorsSpace: CGColorSpaceCreateDeviceRGB(),
        // Ordered from the gradient's START, which is the BOTTOM edge below
        // — CoreGraphics' origin is bottom-left, so the dark end comes
        // first and the light end last.
        colors: [
            CGColor(red: bottom.r, green: bottom.g, blue: bottom.b, alpha: 1),
            CGColor(red: top.r, green: top.g, blue: top.b, alpha: 1),
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
