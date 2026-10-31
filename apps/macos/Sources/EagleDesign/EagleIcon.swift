import AppKit

/// The App icon as a resource, so a bundle-less `swift run Eagle` still shows the brand in the
/// Dock instead of the generic executable icon.
public enum EagleIcon {
  public static var image: NSImage? {
    Bundle.module.url(forResource: "AppIcon", withExtension: "icns")
      .flatMap { NSImage(contentsOf: $0) }
  }
}
