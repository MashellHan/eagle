import AppKit
import XCTest

@testable import EagleDesign

/// A bundle-less `swift run Eagle` has no Info.plist icon, so the Dock needs the resource.
final class EagleIconTests: XCTestCase {
  func testTheIconResourceLoads() throws {
    let image = try XCTUnwrap(EagleIcon.image)
    XCTAssertEqual(image.size.width, image.size.height)
    XCTAssertGreaterThan(image.size.width, 0)
  }
}
