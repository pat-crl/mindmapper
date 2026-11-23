import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum IconError: Error {
    case renderFailed(Int)
    case pngFailed(URL)
    case iconutilFailed(Int32)
}

let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

func color(_ rgb: UInt32, alpha: CGFloat = 1) -> CGColor {
    let red = CGFloat((rgb >> 16) & 255) / 255
    let green = CGFloat((rgb >> 8) & 255) / 255
    let blue = CGFloat(rgb & 255) / 255
    return CGColor(colorSpace: colorSpace, components: [red, green, blue, alpha])!
}

func roundedRect(_ rect: CGRect, radiusX: CGFloat, radiusY: CGFloat) -> CGPath {
    CGPath(roundedRect: rect, cornerWidth: radiusX, cornerHeight: radiusY, transform: nil)
}

func fillRing(in context: CGContext, rect: CGRect, radiusX: CGFloat, radiusY: CGFloat, width: CGFloat, color: CGColor) {
    let inner = rect.insetBy(dx: width, dy: width)
    context.addPath(roundedRect(rect, radiusX: radiusX, radiusY: radiusY))
    if !inner.isEmpty {
        context.addPath(roundedRect(inner, radiusX: max(0, radiusX - width), radiusY: max(0, radiusY - width)))
    }
    context.setFillColor(color)
    context.fillPath(using: .evenOdd)
}

func drawLoopIcon(size: Int) throws -> CGImage {
    guard let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        throw IconError.renderFailed(size)
    }
    // Use the percentages from the selected Loop study. Leave transparent room around the tile for the Dock.
    let tileSize = CGFloat(size) * 0.82
    let inset = (CGFloat(size) - tileSize) / 2
    let scale = tileSize / 100
    context.translateBy(x: inset, y: CGFloat(size) - inset)
    context.scaleBy(x: scale, y: -scale)

    let tile = CGRect(x: 0, y: 0, width: 100, height: 100)
    let direction = CGFloat(145) * .pi / 180
    let dx = sin(direction)
    let dy = -cos(direction)
    let reach = 50 * (abs(dx) + abs(dy))
    let gradient = CGGradient(colorsSpace: colorSpace, colors: [color(0x435475), color(0x202D43)] as CFArray, locations: [0, 1])!
    context.saveGState()
    context.addPath(roundedRect(tile, radiusX: 24, radiusY: 24))
    context.clip()
    context.drawLinearGradient(gradient,
                               start: CGPoint(x: 50 - dx * reach, y: 50 - dy * reach),
                               end: CGPoint(x: 50 + dx * reach, y: 50 + dy * reach), options: [])
    context.restoreGState()

    fillRing(in: context, rect: tile, radiusX: 24, radiusY: 24, width: max(0.65, 0.5 / scale),
             color: color(0x7B8AA9, alpha: CGFloat(143) / 255))
    fillRing(in: context, rect: CGRect(x: 23, y: 28, width: 54, height: 42),
             radiusX: 8.64, radiusY: 6.72, width: max(6, 0.94 / scale), color: color(0xA6BDE5))

    context.setFillColor(color(0xDBE8FF))
    for node in [CGRect(x: 15, y: 22, width: 24, height: 22), CGRect(x: 61, y: 55, width: 24, height: 22)] {
        context.addPath(roundedRect(node, radiusX: 5.28, radiusY: 4.84))
        context.fillPath()
    }
    context.fillEllipse(in: CGRect(x: 44, y: 61, width: 13, height: 13))
    guard let image = context.makeImage() else { throw IconError.renderFailed(size) }
    return image
}

func writePNG(size: Int, to url: URL) throws {
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        throw IconError.pngFailed(url)
    }
    CGImageDestinationAddImage(destination, try drawLoopIcon(size: size), nil)
    guard CGImageDestinationFinalize(destination) else { throw IconError.pngFailed(url) }
}

guard CommandLine.arguments.count == 2 else {
    print("Usage: swift MakeLoopIcon.swift /path/to/AppIcon.icns")
    exit(2)
}

let output = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
let files = FileManager.default
let scratch = files.temporaryDirectory.appendingPathComponent("MindMapperIcon-\(UUID())", isDirectory: true)
let iconset = scratch.appendingPathComponent("Loop.iconset", isDirectory: true)
try files.createDirectory(at: iconset, withIntermediateDirectories: true)
defer { try? files.removeItem(at: scratch) }
for points in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let suffix = scale == 2 ? "@2x" : ""
        let name = "icon_\(points)x\(points)\(suffix).png"
        try writePNG(size: points * scale, to: iconset.appendingPathComponent(name))
    }
}

try files.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", "-o", output.path, iconset.path]
try iconutil.run()
iconutil.waitUntilExit()
guard iconutil.terminationStatus == 0 else { throw IconError.iconutilFailed(iconutil.terminationStatus) }
