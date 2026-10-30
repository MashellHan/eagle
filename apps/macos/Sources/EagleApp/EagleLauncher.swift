import EagleDevices
import Foundation

/// Maintenance must branch before SwiftUI, the shared models, or the Bot daemon initialize.
@main enum EagleLauncher {
  @MainActor static func main() async {
    guard CommandLine.arguments.contains("--prepare-device-update") else {
      EagleApp.main()
      return
    }
    guard CommandLine.arguments.count == 2 else { exit(64) }
    do {
      try await DeviceSystemControl().stop()
    } catch {
      let diagnostic = error as NSError
      FileHandle.standardError.write(
        Data("device_update_preparation_failed: \(diagnostic.domain) \(diagnostic.code)\n".utf8))
      exit(1)
    }
  }
}
