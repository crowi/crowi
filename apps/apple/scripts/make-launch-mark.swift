import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Compose the launch screen's centred mark: the Crowi mark in white on
// transparency, at the three scales `UIImageName` resolves.
//
// Usage:
//   swift apps/apple/scripts/make-launch-mark.swift <mark.png> <out-dir>
//   writes launch-mark.png / @2x / @3x into <out-dir>
//
// Same masking trick as `make-app-icon.swift`, and for the same reason: the
// available logos exist in a dark and a white version and only their ALPHA
// carries the shape, so painting through the alpha makes the source's own
// colour irrelevant. Unlike the icon this output KEEPS its alpha — the
// launch screen's background is a colour asset behind it, not part of the
// artwork.
let pointSize: CGFloat = 96

guard CommandLine.arguments.count == 3 else {
    FileHandle.standardError.write(Data("usage: make-launch-mark.swift <mark.png> <out-dir>\n".utf8))
    exit(2)
}
let sourceURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputDirectory = URL(fileURLWithPath: CommandLine.arguments[2])

guard
    let source = CGImageSourceCreateWithURL(sourceURL as CFURL, nil),
    let mark = CGImageSourceCreateImageAtIndex(source, 0, nil)
else {
    FileHandle.standardError.write(Data("cannot read \(sourceURL.path)\n".utf8))
    exit(1)
}

for scale in 1...3 {
    let side = Int(pointSize * CGFloat(scale))
    guard
        let ctx = CGContext(
            data: nil,
            width: side,
            height: side,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )
    else {
        FileHandle.standardError.write(Data("cannot create context\n".utf8))
        exit(1)
    }
    ctx.interpolationQuality = .high
    let rect = CGRect(x: 0, y: 0, width: side, height: side)
    ctx.clip(to: rect, mask: mark)
    ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
    ctx.fill(rect)

    let suffix = scale == 1 ? "" : "@\(scale)x"
    let outputURL = outputDirectory.appendingPathComponent("launch-mark\(suffix).png")
    guard
        let image = ctx.makeImage(),
        let destination = CGImageDestinationCreateWithURL(outputURL as CFURL, UTType.png.identifier as CFString, 1, nil)
    else {
        FileHandle.standardError.write(Data("cannot encode \(outputURL.lastPathComponent)\n".utf8))
        exit(1)
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        FileHandle.standardError.write(Data("cannot write \(outputURL.path)\n".utf8))
        exit(1)
    }
    print("wrote \(outputURL.path) (\(side)×\(side))")
}
