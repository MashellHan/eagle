import AppKit

/// The App icon as a resource, so a bundle-less `swift run Eagle` still shows the brand in the
/// Dock instead of the generic executable icon.
public enum EagleIcon {
  public static var image: NSImage? {
    // `Bundle.module` only exists in a SwiftPM build: a bare `swiftc` fixture has no resource
    // bundle, and an App comes with its own Info.plist icon instead.
    #if SWIFT_PACKAGE
      return Bundle.module.url(forResource: "AppIcon", withExtension: "icns")
        .flatMap { NSImage(contentsOf: $0) }
    #else
      return nil
    #endif
  }
}
