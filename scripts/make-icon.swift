// Draws the Battery Speed app icon as a 1024px PNG.
// Usage: xcrun swift scripts/make-icon.swift <output.png> [--full-bleed]
// build-menubar.sh turns the PNG into the .icns the Mac app uses.
// --full-bleed fills the whole square with no transparency, as iOS requires
// (iOS rounds the corners itself).

import AppKit

let size: CGFloat = 1024
let output = CommandLine.arguments.dropFirst().first ?? "icon.png"
let fullBleed = CommandLine.arguments.contains("--full-bleed")

let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size),
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
)!
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let ctx = NSGraphicsContext.current!.cgContext

func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: a)
}
let rgb = CGColorSpace(name: CGColorSpace.sRGB)!

// macOS icon grid: an 824px rounded square centred on the 1024px canvas.
let tile = fullBleed ? CGRect(x: 0, y: 0, width: size, height: size) : CGRect(x: 100, y: 100, width: 824, height: 824)
let corner: CGFloat = fullBleed ? 0 : 185
let tilePath = CGPath(roundedRect: tile, cornerWidth: corner, cornerHeight: corner, transform: nil)

// Soft drop shadow under the tile (not on iOS, where the system draws the shape).
ctx.saveGState()
if !fullBleed { ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: color(0, 0, 0, 0.35)) }
ctx.addPath(tilePath)
ctx.setFillColor(color(16, 18, 17))
ctx.fillPath()
ctx.restoreGState()

// Tile: near-black, lifting slightly toward the top.
ctx.saveGState()
ctx.addPath(tilePath)
ctx.clip()
let base = CGGradient(colorsSpace: rgb, colors: [color(34, 40, 36), color(11, 11, 12)] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(base, start: CGPoint(x: 512, y: tile.maxY), end: CGPoint(x: 512, y: tile.minY), options: [])

// Green glow behind the bolt, like the dashboard when charging.
let glow = CGGradient(
    colorsSpace: rgb,
    colors: [color(12, 163, 12, 0.55), color(12, 163, 12, 0.12), color(12, 163, 12, 0)] as CFArray,
    locations: [0, 0.55, 1]
)!
ctx.drawRadialGradient(glow, startCenter: CGPoint(x: 512, y: 500), startRadius: 0,
                       endCenter: CGPoint(x: 512, y: 500), endRadius: 430, options: [])

// A liquid level across the lower part of the tile, with a wave on top.
let wave = CGMutablePath()
let x0 = tile.minX, x1 = tile.maxX, y0 = tile.minY
wave.move(to: CGPoint(x: x0, y: 372))
wave.addCurve(to: CGPoint(x: 512, y: 372), control1: CGPoint(x: x0 + 136, y: 432), control2: CGPoint(x: 376, y: 312))
wave.addCurve(to: CGPoint(x: x1, y: 372), control1: CGPoint(x: 648, y: 432), control2: CGPoint(x: 788, y: 312))
wave.addLine(to: CGPoint(x: x1, y: y0))
wave.addLine(to: CGPoint(x: x0, y: y0))
wave.closeSubpath()
ctx.addPath(wave)
ctx.setFillColor(color(12, 163, 12, 0.30))
ctx.fillPath()
ctx.restoreGState()

// The bolt, in the same shape the dashboard uses (drawn on a 24-unit grid).
let points: [(CGFloat, CGFloat)] = [(13, 2), (4, 14), (11, 14), (10, 22), (19, 10), (12, 10)]
let scale: CGFloat = 27
let origin = CGPoint(x: 512 - 11.5 * scale, y: 512 + 12 * scale) // grid is y-down
let bolt = CGMutablePath()
for (i, p) in points.enumerated() {
    let point = CGPoint(x: origin.x + p.0 * scale, y: origin.y - p.1 * scale)
    if i == 0 { bolt.move(to: point) } else { bolt.addLine(to: point) }
}
bolt.closeSubpath()

ctx.saveGState()
ctx.setShadow(offset: .zero, blur: 46, color: color(60, 220, 60, 0.75))
ctx.setLineJoin(.round)
ctx.setLineWidth(26)
ctx.addPath(bolt)
ctx.setStrokeColor(color(255, 255, 255))
ctx.setFillColor(color(255, 255, 255))
ctx.drawPath(using: .fillStroke) // the stroke rounds the bolt's corners
ctx.restoreGState()

// A faint highlight along the tile's top edge (Mac only).
if !fullBleed {
ctx.saveGState()
ctx.addPath(tilePath)
ctx.setStrokeColor(color(255, 255, 255, 0.10))
ctx.setLineWidth(3)
ctx.strokePath()
ctx.restoreGState()
}

NSGraphicsContext.current = nil
guard let png = rep.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write("Could not encode the icon.\n".data(using: .utf8)!)
    exit(1)
}
try png.write(to: URL(fileURLWithPath: output))
print("Wrote \(output)")
