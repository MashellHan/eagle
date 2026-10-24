import AppKit
import SwiftUI

/// Resolves the bare eagle mark without relying on `Bundle.module`, which traps
/// when the resource bundle is missing from a hand-assembled `.app`.
@MainActor
public enum BrandMark {
  public static let image: NSImage? = {
    let names = [
      "Eagle_EagleDesign.bundle", "EagleDesign_EagleDesign.bundle", "EagleDesign.bundle",
    ]
    var directories: [URL] = []
    if let resources = Bundle.main.resourceURL {
      directories.append(resources)
      directories.append(contentsOf: names.map { resources.appendingPathComponent($0) })
      directories.append(
        contentsOf: names.map {
          resources.appendingPathComponent($0).appendingPathComponent("Contents/Resources")
        })
    }
    directories.append(Bundle.main.bundleURL)
    for directory in directories {
      let url = directory.appendingPathComponent("eagle-mark.png")
      if let image = NSImage(contentsOf: url) { return image }
    }
    return nil
  }()
}
