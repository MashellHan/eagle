import CryptoKit
import Foundation
import ServiceManagement

@MainActor protocol DeviceBackgroundService {
  var status: SMAppService.Status { get }
  func register() throws
  func unregister() async throws
}

extension SMAppService: DeviceBackgroundService {}

/// Tracks installation, not execution readiness or permission to bypass system approval.
@MainActor final class DeviceServiceRegistration {
  private let service: any DeviceBackgroundService
  private let defaults: UserDefaults
  private let key: String
  private var preparing: Task<Void, Error>?

  init(service: any DeviceBackgroundService, defaults: UserDefaults, profile: String) {
    self.service = service
    self.defaults = defaults
    key = "eagle.devices.registeredBundle.\(profile)"
  }

  static func fingerprint(
    appRequirement: String, helperRequirement: String, executable: Data, plist: Data
  ) throws -> String {
    func digest(_ data: Data) -> String {
      SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    return try digest(
      JSONEncoder().encode([appRequirement, helperRequirement, digest(executable), digest(plist)]))
  }

  func prepare(fingerprint: String) async throws {
    if let preparing { return try await preparing.value }
    let task = Task { @MainActor in try await self.update(fingerprint: fingerprint) }
    preparing = task
    defer { preparing = nil }
    try await task.value
  }

  private func update(fingerprint: String) async throws {
    if service.status == .requiresApproval { throw DevicePortError("background_approval_required") }
    let changed = service.status == .enabled && defaults.string(forKey: key) != fingerprint
    if changed {
      // SMAppService caches launch constraints. Updating files/signatures is insufficient.
      // Its asynchronous unregister callback is the boundary before registering a replacement.
      try await service.unregister()
    }
    if changed || service.status == .notRegistered || service.status == .notFound {
      try service.register()
    }
    if service.status == .requiresApproval { throw DevicePortError("background_approval_required") }
    guard service.status == .enabled else { throw DeviceHostError.unavailable }
    defaults.set(fingerprint, forKey: key)
  }

  func stop() async throws {
    if let preparing { _ = try? await preparing.value }
    try await service.unregister()
    defaults.removeObject(forKey: key)
  }
}
