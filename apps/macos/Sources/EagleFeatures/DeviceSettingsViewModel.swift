import Combine
import EagleDevices
import Foundation

public struct DevicePolicyState: Codable, Equatable, Sendable {
  public enum Mode: String, Codable, CaseIterable, Sendable {
    case allApprove = "all-approve"
    case alwaysAsk = "always-ask"
    case paused

    public var title: String {
      switch self {
      case .allApprove: "始终允许"
      case .alwaysAsk: "每次询问"
      case .paused: "暂停执行"
      }
    }
  }
  public let mode: Mode
  public let version: Int
}

public struct DeviceDirectoryEntry: Codable, Equatable, Identifiable, Sendable {
  public let deviceId: String
  public let name: String
  public let platform: String
  public let arch: String
  public let groupId: String?
  public let online: Bool?
  public let lastSeenAt: Int64?
  public let capabilities: [String]?
  public let policy: DevicePolicyState?
  public var id: String { deviceId }
  public var connectionLabel: String {
    switch online {
    case true: "在线"
    case false: "离线"
    default: "连接未知"
    }
  }
}

public struct DeviceDirectoryState: Codable, Equatable, Sendable {
  public let localDeviceId: String
  public let groupId: String?
  public let revision: Int
  public let observationRevision: String
  public let devices: [DeviceDirectoryEntry]
}

public struct DevicePairingInvitation: Codable, Equatable, Sendable {
  public let code: String
  public let expiresAt: Int64
}

private struct DeviceServiceState: Decodable {
  let deviceId: String?
  let localReady: Bool
  let cloudStatus: String
}

/// One App-wide control surface. Only request IDs and the disabled preference are persisted.
@MainActor public final class DeviceSettingsViewModel: ObservableObject {
  public static let shared = DeviceSettingsViewModel()
  public static let disabledKey = "eagle.devices.disabled"
  public static let pendingRedeemKey = "eagle.devices.pendingRedeemRequestId"

  @Published public private(set) var enabled: Bool
  @Published public private(set) var localReady = false
  @Published public private(set) var cloudStatus = "unknown"
  @Published public private(set) var directory: DeviceDirectoryState?
  @Published public private(set) var directoryIsStale = true
  @Published public private(set) var policy: DevicePolicyState?
  @Published public private(set) var invitation: DevicePairingInvitation?
  @Published public private(set) var pendingRedeemRequestId: String?
  @Published public private(set) var pendingApproval: DeviceApprovalRequest?
  @Published public private(set) var errorCode: String?
  @Published public private(set) var isStarting = false
  @Published public private(set) var isRefreshing = false
  @Published public private(set) var isBusy = false

  private let control: any DeviceControl
  private let defaults: UserDefaults
  private let now: @MainActor () -> Date
  private var started = false
  private var localDeviceId: String?
  private var startTask: Task<Void, Never>?
  private var approvalContinuation: CheckedContinuation<Bool, Never>?
  private var approvalExpiry: Task<Void, Never>?

  public init(
    control: any DeviceControl = DeviceSystemControl(), defaults: UserDefaults = .standard,
    now: @escaping @MainActor () -> Date = { Date() }
  ) {
    self.control = control
    self.defaults = defaults
    self.now = now
    enabled = !defaults.bool(forKey: Self.disabledKey)
    let saved = defaults.string(forKey: Self.pendingRedeemKey)
    pendingRedeemRequestId = saved.flatMap { UUID(uuidString: $0)?.uuidString.lowercased() }
  }

  public var needsBackgroundApproval: Bool { errorCode == "background_approval_required" }
  public var socketPath: String? { enabled && localReady ? control.socketPath : nil }
  public var controlsBusy: Bool { isStarting || isRefreshing || isBusy }
  public var errorMessage: String? {
    guard let errorCode else { return nil }
    switch errorCode {
    case "background_approval_required":
      return "请在系统设置中允许 Eagle 在后台运行，然后重试。"
    case "group_conflict": return "两台设备已属于不同设备群。请先退出原群，再配对。"
    case "pairing_unavailable", "pairing_not_found": return "配对码已过期、已作废或不存在。"
    case "pairing_consumed": return "这个配对码已被另一台设备使用。"
    case "pairing_result_expired": return "配对结果已超过保留期限，请刷新设备目录。"
    case "result_not_found": return "还没有查到原请求的结果。可稍后重试查询。"
    case "rate_limited": return "请求过于频繁，请稍后再试。"
    case "invalid_pairing_ttl": return "配对码有效期必须在 1 秒至 24 小时之间。"
    case "empty_pairing_code": return "请输入另一台设备的配对码。"
    case "device_service_timeout": return "服务响应超时。配对结果不确定时，请查询原请求。"
    default: return "设备服务暂时不可用，请重试。"
    }
  }

  public func startIfNeeded() async {
    guard enabled else { return }
    if let startTask {
      await startTask.value
      return
    }
    guard !started else { return }
    isStarting = true
    let task = Task { @MainActor [weak self] in
      guard let self else { return }
      do {
        try await control.start { [weak self] request in
          guard let self else { return false }
          return await self.confirm(request)
        }
        started = true
        if enabled {
          await refresh()
          if pendingRedeemRequestId != nil { await recoverPairing() }
        }
      } catch { record(error) }
      isStarting = false
    }
    startTask = task
    await task.value
    startTask = nil
  }

  public func setEnabled(_ value: Bool) async {
    guard !isBusy else { return }
    enabled = value
    defaults.set(!value, forKey: Self.disabledKey)
    if value {
      await startIfNeeded()
      return
    }
    respondToApproval(false)
    invitation = nil
    if let startTask { await startTask.value }
    isBusy = true
    defer { isBusy = false }
    do {
      try await control.stop()
      started = false
      localReady = false
      cloudStatus = "unknown"
      directoryIsStale = true
      errorCode = nil
    } catch { record(error) }
  }

  public func openSystemSettings() { control.openSystemSettings() }

  public func refresh() async {
    guard enabled, started, !isRefreshing else { return }
    isRefreshing = true
    defer { isRefreshing = false }
    do {
      let status = try await control.call("service.status", params: nil).decoded(
        DeviceServiceState.self)
      guard enabled else { return }
      localReady = status.localReady
      localDeviceId = status.deviceId
      cloudStatus = status.cloudStatus
      guard localReady else {
        directoryIsStale = true
        return
      }
      let current = try await control.call("directory", params: nil)
      guard enabled else { return }
      try applyDirectory(current)
      policy = try await control.call("policy.get", params: nil).decoded(DevicePolicyState.self)
      errorCode = nil
    } catch {
      directoryIsStale = true
      record(error)
    }
  }

  public func setPolicy(_ mode: DevicePolicyState.Mode) async {
    await perform {
      let result = try await self.control.call(
        "policy.set", params: .object(["mode": .string(mode.rawValue)]))
      self.policy = try result.decoded(DevicePolicyState.self)
      self.respondToApproval(false)
      await self.refresh()
    }
  }

  public func createPairing(ttlSeconds: Int = 3600) async {
    guard (1...86400).contains(ttlSeconds) else {
      errorCode = "invalid_pairing_ttl"
      return
    }
    await perform {
      self.invitation = try await self.control.call(
        "pairing.create", params: .object(["ttlSeconds": .number(Double(ttlSeconds))])
      ).decoded(DevicePairingInvitation.self)
    }
  }

  public func revokePairing() async {
    guard let invitation else { return }
    await perform {
      _ = try await self.control.call(
        "pairing.revoke", params: .object(["code": .string(invitation.code)]))
      self.invitation = nil
    }
  }

  public func redeem(code: String) async {
    let code = code.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !code.isEmpty else {
      errorCode = "empty_pairing_code"
      return
    }
    // Never switch to a different request ID while the previous outcome is uncertain.
    if pendingRedeemRequestId != nil {
      await recoverPairing()
      return
    }
    await perform {
      let requestId = UUID().uuidString.lowercased()
      self.defaults.set(requestId, forKey: Self.pendingRedeemKey)
      self.pendingRedeemRequestId = requestId
      do {
        let result = try await self.control.call(
          "pairing.redeem",
          params: .object(["requestId": .string(requestId), "code": .string(code)]))
        try self.acceptPairingResult(result, requestId: requestId)
        await self.refresh()
      } catch {
        // These are definitive rejections; transport/host failures retain the original ID.
        if let port = error as? DevicePortError,
          [
            "group_conflict", "pairing_unavailable", "pairing_consumed", "pairing_result_expired",
            "request_conflict", "rate_limited", "invalid_request",
          ].contains(port.code)
        {
          self.clearPendingRedemption()
        }
        throw error
      }
    }
  }

  public func recoverPairing() async {
    guard let requestId = pendingRedeemRequestId else { return }
    await perform {
      let result = try await self.control.call(
        "pairing.result", params: .object(["requestId": .string(requestId)]))
      try self.acceptPairingResult(result, requestId: requestId)
      await self.refresh()
    }
  }

  public func removeMember(_ deviceId: String) async {
    await perform {
      _ = try await self.control.call(
        "member.remove", params: .object(["deviceId": .string(deviceId)]))
      await self.refresh()
    }
  }

  private func perform(_ action: @MainActor () async throws -> Void) async {
    guard enabled, started, localReady else {
      errorCode = "device_service_unavailable"
      return
    }
    guard !isBusy else { return }
    isBusy = true
    errorCode = nil
    defer { isBusy = false }
    do { try await action() } catch { record(error) }
  }

  private func applyDirectory(_ value: DeviceJSON) throws {
    let current = try value.decoded(DeviceDirectoryState.self)
    if directory?.revision != current.revision
      || directory?.observationRevision != current.observationRevision
    {
      directory = current
    }
    directoryIsStale = false
    if value["cloudStatus"]?.string == "offline" { cloudStatus = "offline" }
  }

  private func acceptPairingResult(_ value: DeviceJSON, requestId: String) throws {
    guard value["requestId"]?.string == requestId, let current = value["directory"] else {
      throw DeviceHostError.invalidResponse
    }
    try applyDirectory(current)
    clearPendingRedemption()
  }

  private func clearPendingRedemption() {
    defaults.removeObject(forKey: Self.pendingRedeemKey)
    pendingRedeemRequestId = nil
  }

  private func record(_ error: any Error) {
    errorCode =
      (error as? DevicePortError)?.code ?? (error as? DeviceHostError)?.rawValue
      ?? "device_request_failed"
  }

  private func confirm(_ request: DeviceApprovalRequest) async -> Bool {
    guard enabled, started, localReady, pendingApproval == nil,
      let localDeviceId,
      (try? request.validate(sourceDeviceId: localDeviceId, now: milliseconds)) != nil
    else { return false }
    return await withTaskCancellationHandler {
      await withCheckedContinuation { continuation in
        pendingApproval = request
        approvalContinuation = continuation
        let delay = max(0, request.expiresAt - milliseconds)
        approvalExpiry = Task { @MainActor [weak self] in
          do { try await Task.sleep(for: .milliseconds(delay)) } catch { return }
          self?.respondToApproval(false)
        }
      }
    } onCancel: {
      Task { @MainActor [weak self] in
        if self?.pendingApproval?.id == request.id { self?.respondToApproval(false) }
      }
    }
  }

  public func respondToApproval(_ allow: Bool) {
    guard let continuation = approvalContinuation, let request = pendingApproval else { return }
    let accepted = allow && enabled && started && localReady && request.expiresAt > milliseconds
    approvalExpiry?.cancel()
    approvalExpiry = nil
    approvalContinuation = nil
    pendingApproval = nil
    continuation.resume(returning: accepted)
  }

  private var milliseconds: Int64 { Int64(now().timeIntervalSince1970 * 1000) }
}
