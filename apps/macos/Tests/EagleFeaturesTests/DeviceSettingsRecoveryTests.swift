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
