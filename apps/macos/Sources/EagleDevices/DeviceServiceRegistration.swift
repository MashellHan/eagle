import CoreServices
import CryptoKit
import Foundation
import OSLog
import ServiceManagement

protocol DeviceBackgroundService: Sendable {
  func currentStatus() async -> SMAppService.Status
  func register() async throws
  func unregister() async throws
}

/// ServiceManagement and LaunchServices may block; keep their IPC off the UI actor.
actor SystemDeviceBackgroundService: DeviceBackgroundService {
  private let service: SMAppService
  private let bundle: URL
  private let isCandidate: Bool
  private let candidateRegistration = DeviceCandidateRegistration()

  init(plistName: String, bundle: URL, isCandidate: Bool = false) {
    service = SMAppService.agent(plistName: plistName)
    self.bundle = bundle
    self.isCandidate = isCandidate
  }

  func currentStatus() -> SMAppService.Status { service.status }
  func register() throws {
    if isCandidate {
      try candidateRegistration.refresh(bundle)
    } else if LSRegisterURL(bundle as CFURL, true) != noErr {
      throw DevicePortError("background_registration_failed")
    }
    try Task.checkCancellation()
    try service.register()
  }
  func unregister() async throws { try await service.unregister() }
}

/// Coordinates registration and helper contact; only the helper can report runtime readiness.
@MainActor final class DeviceServiceRegistration {
  private let service: any DeviceBackgroundService
  private let defaults: UserDefaults
  private let key: String
  private let pendingKey: String
  private var preparing: Task<Void, Error>?
  private var recoveryFingerprint: String?
  private let log = Logger(subsystem: "ai.hexly.eagle.devices", category: "background")

  init(service: any DeviceBackgroundService, defaults: UserDefaults, profile: String) {
    self.service = service
    self.defaults = defaults
    key = "eagle.devices.registeredBundle.\(profile)"
    pendingKey = key + ".pending"
  }

  nonisolated static func fingerprint(
    appRequirement: String, helperRequirement: String, executable: Data, plist: Data
  ) throws -> String {
    func digest(_ data: Data) -> String {
      SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    return try digest(
      JSONEncoder().encode([appRequirement, helperRequirement, digest(executable), digest(plist)]))
  }

  func prepare(
    fingerprint: String, connect: @escaping @MainActor () async throws -> Void = {}
  ) async throws {
    if let preparing { return try await preparing.value }
    let task = Task { @MainActor in
      if self.recoveryFingerprint == fingerprint {
        let status = await self.service.currentStatus()
        if status == .requiresApproval { throw DevicePortError("background_approval_required") }
        guard status == .enabled else { throw DeviceHostError.unavailable }
        // A later read may observe recovery, but must not mutate a failed registration again.
        try await connect()
        self.recoveryFingerprint = nil
        return
      }
      try await self.update(fingerprint: fingerprint)
      do {
        try await connect()
        self.recoveryFingerprint = nil
      } catch {
        guard Self.isTransportFailure(error) else { throw error }
        let status = await self.service.currentStatus()
        if status == .requiresApproval { throw DevicePortError("background_approval_required") }
        guard self.recoveryFingerprint != fingerprint else { throw error }
        self.recoveryFingerprint = fingerprint
        self.log.info(
          "background helper recovery: refreshing registration after failed handshake")
        if status == .enabled {
          try await self.service.unregister()
          self.defaults.removeObject(forKey: self.pendingKey)
        }
        try await self.update(fingerprint: fingerprint)
        try await connect()
        self.recoveryFingerprint = nil
      }
    }
    preparing = task
    defer { preparing = nil }
    try await task.value
  }

  /// An explicit retry grants one new recovery attempt without changing the user's preference.
  func resetRecovery() { recoveryFingerprint = nil }

  private static func isTransportFailure(_ error: any Error) -> Bool {
    let code = (error as? DevicePortError)?.code ?? (error as? DeviceHostError)?.rawValue
    return code == "device_service_timeout" || code == "device_service_unavailable"
  }

  private func update(fingerprint: String) async throws {
    var status = await service.currentStatus()
    log.info("background status before registration: \(status.rawValue, privacy: .public)")
    if status == .requiresApproval { throw DevicePortError("background_approval_required") }
    let registered = defaults.string(forKey: pendingKey) ?? defaults.string(forKey: key)
    let changed = status == .enabled && registered != fingerprint
    if changed {
      // SMAppService caches launch constraints. Updating files/signatures is insufficient.
      // Its asynchronous unregister callback is the boundary before registering a replacement.
      try await service.unregister()
      defaults.removeObject(forKey: pendingKey)
      status = .notRegistered
    }
    if status == .notRegistered || status == .notFound {
      try await service.register()
      // Registration may succeed before system approval. Keep that binding across App launches.
      defaults.set(fingerprint, forKey: pendingKey)
      status = await service.currentStatus()
    }
    log.info("background status after registration: \(status.rawValue, privacy: .public)")
    if status == .requiresApproval { throw DevicePortError("background_approval_required") }
    guard status == .enabled else { throw DeviceHostError.unavailable }
    defaults.set(fingerprint, forKey: key)
    defaults.removeObject(forKey: pendingKey)
  }

  func stop() async throws {
    if let preparing { _ = try? await preparing.value }
    try await service.unregister()
    defaults.removeObject(forKey: key)
    defaults.removeObject(forKey: pendingKey)
    recoveryFingerprint = nil
  }
}
