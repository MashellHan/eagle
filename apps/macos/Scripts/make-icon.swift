import AppKit
import Foundation

/// Builds `Support/AppIcon.iconset` from the Eagle brand composition and packs
/// it into `Support/AppIcon.icns`.
///
/// Source artwork: hexly.ai `public/brands/eagle/v1.0.0/hero-square.webp`
/// (authored composition of the approved 2048 px eagle foreground plus its
/// mountain-birch texture). Copied here as PNG so the build needs no network
/// and no sibling checkout.
///
///     swift Scripts/make-icon.swift

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let source = root.appendingPathComponent("Support/Brand/eagle-hero-square.png")
let iconset = root.appendingPathComponent("Support/AppIcon.iconset")
let output = root.appendingPathComponent("Support/AppIcon.icns")

guard let image = NSImage(contentsOf: source) else {
  print("missing \(source.path)")
  exit(1)
}

/// Apple's macOS icon grid: an 824 pt body centred in a 1024 pt canvas with a
/// 185 pt corner radius.
let canvas: CGFloat = 1024
let inset: CGFloat = 100
let radius: CGFloat = 185

func render(_ size: CGFloat) -> Data? {
  let pixels = Int(size)
  guard
    let rep = NSBitmapImageRep(
      bitmapDataPlanes: nil,
      pixelsWide: pixels,
      pixelsHigh: pixels,
      bitsPerSample: 8,
      samplesPerPixel: 4,
      hasAlpha: true,
      isPlanar: false,
      colorSpaceName: .deviceRGB,
      bytesPerRow: 0,
      bitsPerPixel: 0
    )
  else { return nil }
  rep.size = NSSize(width: size, height: size)

  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  let scale = size / canvas
  let body = NSRect(
    x: inset * scale,
    y: inset * scale,
    width: (canvas - inset * 2) * scale,
    height: (canvas - inset * 2) * scale
  )
  let clip = NSBezierPath(
    roundedRect: body,
    xRadius: radius * scale,
    yRadius: radius * scale
  )
  clip.addClip()
  image.draw(in: body, from: .zero, operation: .sourceOver, fraction: 1)

  // Hairline highlight so the edge stays crisp on light and dark desktops.
  NSColor.white.withAlphaComponent(0.20).setStroke()
  clip.lineWidth = max(1, scale)
  clip.stroke()

  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])
}

try? FileManager.default.removeItem(at: iconset)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

let variants: [(String, CGFloat)] = [
  ("icon_16x16", 16),
  ("icon_16x16@2x", 32),
  ("icon_32x32", 32),
  ("icon_32x32@2x", 64),
  ("icon_128x128", 128),
  ("icon_128x128@2x", 256),
  ("icon_256x256", 256),
  ("icon_256x256@2x", 512),
  ("icon_512x512", 512),
  ("icon_512x512@2x", 1024),
]

for (name, size) in variants {
  guard let data = render(size) else {
    print("failed to render \(name)")
    exit(1)
  }
  try data.write(to: iconset.appendingPathComponent("\(name).png"))
}

let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", iconset.path, "-o", output.path]
try iconutil.run()
iconutil.waitUntilExit()
guard iconutil.terminationStatus == 0 else {
  print("iconutil failed")
  exit(1)
}
print("wrote \(output.path)")
