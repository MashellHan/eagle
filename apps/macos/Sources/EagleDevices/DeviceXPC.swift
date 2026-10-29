import Foundation
import Security

@objc public protocol DeviceHostXPC {
  func request(_ data: Data, reply: @escaping @Sendable (Data) -> Void)
}
@objc public protocol DeviceAppXPC {
  func confirm(_ data: Data, reply: @escaping @Sendable (Bool) -> Void)
}

public enum DeviceCodeIdentity {
  public static func applicationRequirement(at url: URL) throws -> String {
    let requirement = try self.requirement(at: url)
    var app: SecStaticCode?
    var own: SecCode?
    var ownStatic: SecStaticCode?
    guard SecStaticCodeCreateWithPath(url as CFURL, [], &app) == errSecSuccess, let app,
      SecCodeCopySelf([], &own) == errSecSuccess, let own,
      SecCodeCopyStaticCode(own, [], &ownStatic) == errSecSuccess, let ownStatic
    else { throw DeviceHostError.forbidden }
    // A release helper accepts only the App signed by its own team. Ad-hoc local
    // candidates use the App's exact designated cdhash and are not release evidence.
    guard try team(app) == team(ownStatic) else { throw DeviceHostError.forbidden }
    return requirement
  }
  private static func team(_ code: SecStaticCode) throws -> String? {
    var info: CFDictionary?
    guard
      SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info)
        == errSecSuccess,
      let values = info as? [String: Any]
    else { throw DeviceHostError.forbidden }
    return values[kSecCodeInfoTeamIdentifier as String] as? String
  }
  public static func requirement(at url: URL) throws -> String {
    var code: SecStaticCode?
    guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code,
      SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), nil)
        == errSecSuccess
    else { throw DeviceHostError.forbidden }
    return try text(code)
  }
  public static func currentRequirement() throws -> String {
    var code: SecCode?
    guard SecCodeCopySelf([], &code) == errSecSuccess, let code else {
      throw DeviceHostError.forbidden
    }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else {
      throw DeviceHostError.forbidden
    }
    return try text(staticCode)
  }
  private static func text(_ code: SecStaticCode) throws -> String {
    var requirement: SecRequirement?
    var value: CFString?
    guard SecCodeCopyDesignatedRequirement(code, [], &requirement) == errSecSuccess,
      let requirement,
      SecRequirementCopyString(requirement, [], &value) == errSecSuccess, let value
    else { throw DeviceHostError.forbidden }
    return value as String
  }
}

@MainActor private final class DeviceReply<Value: Sendable> {
  private var continuation: CheckedContinuation<Value, Never>?
  private var timeout: Task<Void, Never>?
  init(_ continuation: CheckedContinuation<Value, Never>, timeoutSeconds: Double, fallback: Value) {
    self.continuation = continuation
    timeout = Task { [weak self] in
      do { try await Task.sleep(for: .seconds(max(0, timeoutSeconds))) } catch { return }
      self?.resolve(fallback)
    }
  }
  func resolve(_ value: Value) {
    guard let continuation else { return }
    self.continuation = nil
    timeout?.cancel()
    continuation.resume(returning: value)
  }
}

/// Each message is checked by XPC against the expected App signature, not just its UID or PID.
public final class DeviceXPCServer: NSObject, NSXPCListenerDelegate, @unchecked Sendable {
  private let host: DeviceServiceHost
  private let requiredPeer: String
  public init(host: DeviceServiceHost, requiredPeer: String) {
    self.host = host
    self.requiredPeer = requiredPeer
  }
  public func listener(
    _ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection
  ) -> Bool {
    guard connection.effectiveUserIdentifier == getuid() else { return false }
    connection.setCodeSigningRequirement(requiredPeer)
    connection.exportedInterface = NSXPCInterface(with: DeviceHostXPC.self)
    connection.remoteObjectInterface = NSXPCInterface(with: DeviceAppXPC.self)
    let peer = DeviceHostPeer(host: host, connection: connection)
    connection.exportedObject = peer
    connection.invalidationHandler = { Task { @MainActor in peer.invalidate() } }
    connection.resume()
    return true
  }
}

private final class DeviceHostPeer: NSObject, DeviceHostXPC, @unchecked Sendable {
  private let host: DeviceServiceHost
  private let connection: NSXPCConnection
  @MainActor private var active = true
  private let id = UUID()
  init(host: DeviceServiceHost, connection: NSXPCConnection) {
    self.host = host
    self.connection = connection
  }
  @MainActor func invalidate() {
    active = false
    host.detachApprover(owner: id)
  }
  func request(_ data: Data, reply: @escaping @Sendable (Data) -> Void) {
    guard data.count <= 524288 else {
      reply(Self.failure("invalid_request"))
      return
    }
    Task { @MainActor [self] in
      guard active else {
        reply(Self.failure("device_service_unavailable"))
        return
      }
      host.attachApprover(owner: id) { [weak self] request in await self?.confirm(request) ?? false
      }
      do {
        let input = try JSONDecoder().decode(DeviceJSON.self, from: data)
        guard let method = input["method"]?.string else { throw DeviceHostError.forbidden }
        let value = try await host.call(method, params: input["params"])
        reply(try JSONEncoder().encode(DeviceJSON.object(["result": value])))
      } catch { reply(Self.failure(Self.code(error))) }
    }
  }
  @MainActor private func confirm(_ request: DeviceApprovalRequest) async -> Bool {
    guard active, let data = try? JSONEncoder().encode(request) else { return false }
    return await withCheckedContinuation { continuation in
      let gate = DeviceReply(
        continuation,
        timeoutSeconds: min(Double(request.expiresAt) / 1000 - Date().timeIntervalSince1970, 55),
        fallback: false)
      guard
        let proxy = connection.remoteObjectProxyWithErrorHandler({ @Sendable _ in
          Task { @MainActor in gate.resolve(false) }
        }) as? DeviceAppXPC
      else {
        gate.resolve(false)
        return
      }
      proxy.confirm(data) { [weak self] approved in
        Task { @MainActor in gate.resolve(self?.active == true && approved) }
      }
    }
  }
  static func code(_ error: any Error) -> String {
    if let error = error as? DevicePortError { return error.code }
    if let error = error as? DeviceHostError { return error.rawValue }
    return "device_request_failed"
  }
  static func failure(_ code: String) -> Data {
    (try? JSONEncoder().encode(DeviceJSON.object(["error": .string(code)]))) ?? Data()
  }
}

@MainActor public final class DeviceXPCClient {
  private let connection: NSXPCConnection
  private let receiver: DeviceApprovalReceiver
  public init(
    connection: NSXPCConnection, requiredPeer: String,
    confirm: @escaping @MainActor @Sendable (DeviceApprovalRequest) async -> Bool
  ) {
    self.connection = connection
    receiver = DeviceApprovalReceiver(confirm: confirm)
    connection.setCodeSigningRequirement(requiredPeer)
    connection.exportedInterface = NSXPCInterface(with: DeviceAppXPC.self)
    connection.exportedObject = receiver
    connection.remoteObjectInterface = NSXPCInterface(with: DeviceHostXPC.self)
    connection.resume()
  }
  public func invalidate() { connection.invalidate() }
  public func call(_ method: String, params: DeviceJSON? = nil) async throws -> DeviceJSON {
    var value: [String: DeviceJSON] = ["method": .string(method)]
    if let params { value["params"] = params }
    let data = try JSONEncoder().encode(DeviceJSON.object(value))
    let result: Result<DeviceJSON, DevicePortError> = await withCheckedContinuation {
      continuation in
      let gate = DeviceReply(
        continuation, timeoutSeconds: 25,
        fallback: .failure(DevicePortError("device_service_timeout")))
      guard
        let proxy = connection.remoteObjectProxyWithErrorHandler({ @Sendable _ in
          Task { @MainActor in gate.resolve(.failure(DevicePortError("device_service_unavailable")))
          }
        }) as? DeviceHostXPC
      else {
        gate.resolve(.failure(DevicePortError("device_service_unavailable")))
        return
      }
      proxy.request(data) { response in
        Task { @MainActor in
          guard response.count <= 524288,
            let value = try? JSONDecoder().decode(DeviceJSON.self, from: response)
          else {
            gate.resolve(.failure(DevicePortError("invalid_device_response")))
            return
          }
          if let error = value["error"]?.string {
            gate.resolve(.failure(DevicePortError(error)))
          } else if let result = value["result"] {
            gate.resolve(.success(result))
          } else {
            gate.resolve(.failure(DevicePortError("invalid_device_response")))
          }
        }
      }
    }
    return try result.get()
  }
}

private final class DeviceApprovalReceiver: NSObject, DeviceAppXPC, @unchecked Sendable {
  let action: @MainActor @Sendable (DeviceApprovalRequest) async -> Bool
  init(confirm: @escaping @MainActor @Sendable (DeviceApprovalRequest) async -> Bool) {
    action = confirm
  }
  func confirm(_ data: Data, reply: @escaping @Sendable (Bool) -> Void) {
    guard data.count <= 524288,
      let request = try? JSONDecoder().decode(DeviceApprovalRequest.self, from: data)
    else {
      reply(false)
      return
    }
    Task { @MainActor in reply(await action(request)) }
  }
}
