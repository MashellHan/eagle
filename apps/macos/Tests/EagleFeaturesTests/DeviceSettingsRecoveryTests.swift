import EagleDevices
import Foundation
import Testing

@testable import EagleFeatures

@Suite("Device settings recovery", .serialized)
@MainActor
struct DeviceSettingsRecoveryTests {
  @Test("failed unregister preserves enabled preference and permits reconnect and retry")
  func failedStop() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    control.stopError = DeviceHostError.failed
    await model.setEnabled(false)
    #expect(model.enabled)
    #expect(!defaults.bool(forKey: DeviceSettingsViewModel.disabledKey))
    await model.startIfNeeded()
    #expect(control.starts == 2)
    #expect(model.localReady)
    control.stopError = nil
    await model.setEnabled(false)
    #expect(!model.enabled)
    #expect(defaults.bool(forKey: DeviceSettingsViewModel.disabledKey))
  }

  @Test("stop in flight cannot register again after a failed status reset")
  func delayedStopBlocksStartup() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    control.handler = { method, _ in
      if method == "service.status" { throw DeviceHostError.unavailable }
      return nil
    }
    await model.refresh()
    control.handler = nil
    var release: CheckedContinuation<Void, Never>?
    control.stopGate = { await withCheckedContinuation { release = $0 } }
    let stopping = Task { await model.setEnabled(false) }
    while release == nil { await Task.yield() }
    await model.startIfNeeded()
    #expect(control.starts == 1)
    release?.resume()
    await stopping.value
    #expect(!model.enabled)
  }

  @Test(
    "dead retry code converges only after a current cloud directory",
    arguments: ["pairing_unavailable", "pairing_consumed", "pairing_result_expired"])
  func deadPairingRetry(code error: String) async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    let code = String(repeating: "a", count: 43)
    control.handler = { method, _ in
      if method == "pairing.redeem" { throw DeviceHostError.timeout }
      return nil
    }
    await model.redeem(code: code)
    var confirmed = false
    control.handler = { method, _ in
      if method == "pairing.result" { throw DevicePortError("result_not_found") }
      if method == "pairing.redeem" { throw DevicePortError(error) }
      if method == "directory" {
        confirmed = true
        return control.directory
      }
      return nil
    }
    await model.redeem(code: code)
    #expect(confirmed)
    #expect(model.errorCode == error)
    #expect(model.pendingRedeemRequestId == nil)
    #expect(defaults.object(forKey: DeviceSettingsViewModel.pendingRedeemKey) == nil)
  }

  @Test("reachable helper surfaces the stable Node failure instead of silently staying unready")
  func nodeFailureStatus() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    control.handler = { method, _ in
      if method == "service.status" {
        return .object([
          "deviceId": .string(deviceSettingsLocalID), "localReady": .bool(false),
          "cloudStatus": .string("offline"), "error": .string("device_initialization_failed"),
        ])
      }
      return nil
    }
    await model.startIfNeeded()
    #expect(!model.localReady)
    #expect(model.errorCode == "device_initialization_failed")
  }

  @Test("explicit Node retry waits for observed readiness without registering again")
  func retryNode() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    var ready = false
    var retried = false
    control.handler = { method, _ in
      if method == "service.status", !ready {
        return .object([
          "deviceId": .string(deviceSettingsLocalID), "localReady": .bool(false),
          "cloudStatus": .string("offline"),
          "error": retried ? .null : .string("device_initialization_failed"),
        ])
      }
      if method == "service.retry" {
        retried = true
        return .object(["starting": .bool(true)])
      }
      return nil
    }
    await model.startIfNeeded()
    #expect(model.canRetryService)
    let retry = Task { await model.retryService() }
    while !retried { await Task.yield() }
    #expect(!model.localReady)
    ready = true
    await retry.value
    #expect(model.localReady)
    #expect(model.errorCode == nil)
    #expect(control.starts == 1)
    #expect(control.calls.filter { $0.0 == "service.retry" }.count == 1)
  }

  @Test(
    "dead retry retains original ID without a cloud directory", arguments: ["offline", "transport"])
  func deadRetryNeedsDirectory(failure: String) async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    let code = String(repeating: "a", count: 43)
    control.handler = { method, _ in
      if method == "pairing.redeem" { throw DeviceHostError.timeout }
      return nil
    }
    await model.redeem(code: code)
    let original = model.pendingRedeemRequestId
    control.handler = { method, _ in
      if method == "pairing.result" { throw DevicePortError("result_not_found") }
      if method == "pairing.redeem" { throw DevicePortError("pairing_unavailable") }
      if method == "directory" {
        if failure == "transport" { throw DeviceHostError.timeout }
        guard case .object(var value) = control.directory else { return nil }
        value["cloudStatus"] = .string("offline")
        return .object(value)
      }
      return nil
    }
    await model.redeem(code: code)
    #expect(model.pendingRedeemRequestId == original)
    #expect(defaults.object(forKey: DeviceSettingsViewModel.pendingRedeemKey) != nil)
  }

  @Test(
    "rate and session retry uncertainty retain the original binding",
    arguments: ["rate_limited", "invalid_session", "revoked_session"])
  func retryUncertain(error: String) async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    let code = String(repeating: "a", count: 43)
    control.handler = { method, _ in
      if method == "pairing.redeem" { throw DeviceHostError.timeout }
      return nil
    }
    await model.redeem(code: code)
    let original = model.pendingRedeemRequestId
    control.handler = { method, _ in
      if method == "pairing.result" { throw DevicePortError("result_not_found") }
      if method == "pairing.redeem" { throw DevicePortError(error) }
      return nil
    }
    await model.redeem(code: code)
    #expect(model.pendingRedeemRequestId == original)
    #expect(model.errorCode == error)
  }

  @Test("self_pairing is a definitive rejection and does not strand a pending request")
  func selfPairing() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    control.handler = { method, _ in
      if method == "pairing.redeem" { throw DevicePortError("self_pairing") }
      return nil
    }
    await model.redeem(code: String(repeating: "a", count: 43))
    #expect(model.errorCode == "self_pairing")
    #expect(model.errorMessage?.contains("本机") == true)
    #expect(model.pendingRedeemRequestId == nil)
    #expect(defaults.object(forKey: DeviceSettingsViewModel.pendingRedeemKey) == nil)
  }

  @Test("self_pairing remains definitive after an uncertain first transmission")
  func selfPairingAfterLoss() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    var lost = true
    control.handler = { method, _ in
      if method == "pairing.result" { throw DevicePortError("result_not_found") }
      if method == "pairing.redeem" {
        if lost {
          lost = false
          throw DeviceHostError.timeout
        }
        throw DevicePortError("self_pairing")
      }
      return nil
    }
    let code = String(repeating: "a", count: 43)
    await model.redeem(code: code)
    #expect(model.pendingRedeemRequestId != nil)
    await model.redeem(code: code)
    #expect(model.errorCode == "self_pairing")
    #expect(model.pendingRedeemRequestId == nil)
  }

  @Test("pre-send loss retries the same ID only with the original code after result_not_found")
  func retryOriginalBinding() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    let code = String(repeating: "a", count: 43)
    var originalID: String?
    control.handler = { method, params in
      if method == "pairing.redeem" {
        originalID = params?["requestId"]?.string
        throw DeviceHostError.timeout
      }
      if method == "pairing.result" { throw DevicePortError("result_not_found") }
      return nil
    }
    await model.redeem(code: code)
    let requestId = try #require(originalID)
    let saved = try #require(defaults.dictionary(forKey: DeviceSettingsViewModel.pendingRedeemKey))
    #expect(saved["requestId"] as? String == requestId)
    #expect((saved["codeHash"] as? String)?.count == 64)
    #expect(!String(describing: saved).contains(code))
    let restored = DeviceSettingsViewModel(control: control, defaults: defaults)
    await restored.startIfNeeded()
    #expect(restored.errorCode == "result_not_found")
    let sent = control.calls.filter { $0.0 == "pairing.redeem" }.count
    await restored.redeem(code: String(repeating: "b", count: 43))
    #expect(restored.errorCode == "request_conflict")
    #expect(control.calls.filter { $0.0 == "pairing.redeem" }.count == sent)
    #expect(restored.pendingRedeemRequestId == requestId)
    control.handler = { method, params in
      if method == "pairing.result" { throw DevicePortError("result_not_found") }
      if method == "pairing.redeem" {
        #expect(params?["requestId"]?.string == requestId)
        #expect(params?["code"]?.string == code)
        return .object(["requestId": .string(requestId), "directory": control.directory])
      }
      return nil
    }
    await restored.redeem(code: code)
    #expect(control.calls.filter { $0.0 == "pairing.redeem" }.count == sent + 1)
    #expect(restored.pendingRedeemRequestId == nil)
    #expect(defaults.object(forKey: DeviceSettingsViewModel.pendingRedeemKey) == nil)
  }
}
