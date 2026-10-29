import EagleDevices
import Foundation
import Security

@main struct EagleDeviceHelper {
  @MainActor static func main() {
    do {
      var bundle = Bundle.main.executableURL?.deletingLastPathComponent()
      while let current = bundle, current.path != "/", current.pathExtension != "app" {
        bundle = current.deletingLastPathComponent()
      }
      guard let bundle, bundle.pathExtension == "app",
        let identifier = Bundle(url: bundle)?.bundleIdentifier,
        ["ai.hexly.eagle.macos", "ai.hexly.eagle.macos.device-candidate"].contains(identifier)
      else { throw DeviceHostError.invalidConfiguration }
      let requirement = try DeviceCodeIdentity.applicationRequirement(at: bundle)
      let config = try DeviceHostConfiguration.load(bundle: bundle)
      let runtime = bundle.appendingPathComponent("Contents/Resources/DeviceRuntime")
      let identity = try DeviceIdentity.loadOrCreate(profile: config.profile)
      let host = DeviceServiceHost(
        identity: identity, configuration: config,
        node: runtime.appendingPathComponent("node"),
        entry: runtime.appendingPathComponent(
          "agent/node_modules/@nocoo/eagle-agent/dist/agent/device-service.js"))
      let listener = NSXPCListener(machServiceName: config.machServiceName)
      let delegate = DeviceXPCServer(host: host, requiredPeer: requirement)
      listener.delegate = delegate
      try host.start()
      listener.resume()
      withExtendedLifetime((host, listener, delegate)) { RunLoop.main.run() }
    } catch {
      // No payload, credential or arbitrary child output reaches a process log.
      exit(78)
    }
  }
}
