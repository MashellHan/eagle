import Foundation
import ServiceManagement
import Testing

@testable import EagleDevices

@MainActor
@Suite("Device background registration", .serialized)
struct DeviceServiceRegistrationTests {
  private let key = "eagle.devices.registeredBundle.test"

  private func fixture(
    status: SMAppService.Status = .enabled
  ) -> (
    DeviceServiceRegistration, BackgroundServiceStub, UserDefaults, String
  ) {
    let domain = "eagle-registration-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: domain)!
    let service = BackgroundServiceStub(status: status)
    return (
      DeviceServiceRegistration(service: service, defaults: defaults, profile: "test"),
      service, defaults, domain
    )
  }

  @Test("changed signed bundle refreshes registration before declaring it current")
  func changedBundle() async throws {
    let (registration, service, defaults, domain) = fixture()
    defer { defaults.removePersistentDomain(forName: domain) }
    defaults.set("old", forKey: key)
    defaults.set(["requestId": "original", "codeHash": "bound"], forKey: "pendingPairing")
    try await registration.prepare(fingerprint: "new")
    #expect(service.events == ["unregister", "register"])
    #expect(defaults.string(forKey: key) == "new")
    #expect(defaults.dictionary(forKey: "pendingPairing")?["requestId"] as? String == "original")
  }

  @Test("an older installation with no fingerprint refreshes only once")
  func legacyRegistration() async throws {
    let (registration, service, defaults, domain) = fixture()
    defer { defaults.removePersistentDomain(forName: domain) }
    try await registration.prepare(fingerprint: "current")
    try await registration.prepare(fingerprint: "current")
    #expect(service.events == ["unregister", "register"])
  }

  @Test("opening the same installation leaves the running helper alone")
  func sameBundle() async throws {
    let (registration, service, defaults, domain) = fixture()
    defer { defaults.removePersistentDomain(forName: domain) }
    defaults.set("current", forKey: key)
    try await registration.prepare(fingerprint: "current")
    #expect(service.events.isEmpty)
  }

  @Test("first installation registers without unregister", arguments: [false, true])
  func firstInstall(notFound: Bool) async throws {
    let (registration, service, defaults, domain) = fixture(
      status: notFound ? .notFound : .notRegistered)
    defer { defaults.removePersistentDomain(forName: domain) }
    try await registration.prepare(fingerprint: "first")
    #expect(service.events == ["register"])
    #expect(defaults.string(forKey: key) == "first")
  }

  @Test("concurrent starts wait for the same completed unregister")
  func delayedUnregister() async throws {
    let (registration, service, defaults, domain) = fixture()
    defer { defaults.removePersistentDomain(forName: domain) }
    defaults.set("old", forKey: key)
    var release: CheckedContinuation<Void, Never>?
    service.unregisterGate = { await withCheckedContinuation { release = $0 } }
    let first = Task { try await registration.prepare(fingerprint: "new") }
    let deadline = Date().addingTimeInterval(1)
    while release == nil, Date() < deadline { try await Task.sleep(for: .milliseconds(5)) }
    let continuation = try #require(release)
    let second = Task { try await registration.prepare(fingerprint: "new") }
    await Task.yield()
    #expect(service.events == ["unregister"])
    #expect(defaults.string(forKey: key) == "old")
    continuation.resume()
    try await first.value
    try await second.value
    #expect(service.events == ["unregister", "register"])
    #expect(defaults.string(forKey: key) == "new")
  }

  @Test("failed unregister retains the old record and does not register")
  func failedUnregister() async throws {
    let (registration, service, defaults, domain) = fixture()
    defer { defaults.removePersistentDomain(forName: domain) }
    defaults.set("old", forKey: key)
    service.unregisterError = DeviceHostError.failed
    await #expect(throws: DeviceHostError.failed) {
      try await registration.prepare(fingerprint: "new")
    }
    #expect(service.events == ["unregister"])
    #expect(defaults.string(forKey: key) == "old")
  }

  @Test("system approval remains pending without unregister or registration")
  func approvalRequired() async throws {
    let (registration, service, defaults, domain) = fixture(status: .requiresApproval)
    defer { defaults.removePersistentDomain(forName: domain) }
    do {
      try await registration.prepare(fingerprint: "new")
      Issue.record("registration must remain pending")
    } catch let error as DevicePortError {
      #expect(error.code == "background_approval_required")
    }
    #expect(service.events.isEmpty)
    #expect(defaults.object(forKey: key) == nil)
  }

  @Test("registration failure does not claim the replacement is installed")
  func failedRegister() async throws {
    let (registration, service, defaults, domain) = fixture(status: .notRegistered)
    defer { defaults.removePersistentDomain(forName: domain) }
    service.registerError = DeviceHostError.failed
    await #expect(throws: DeviceHostError.failed) {
      try await registration.prepare(fingerprint: "new")
    }
    #expect(defaults.object(forKey: key) == nil)
  }

  @Test("unregister clears only the installation record after success")
  func stop() async throws {
    let (registration, service, defaults, domain) = fixture()
    defer { defaults.removePersistentDomain(forName: domain) }
    defaults.set("current", forKey: key)
    service.unregisterError = DeviceHostError.failed
    await #expect(throws: DeviceHostError.failed) { try await registration.stop() }
    #expect(defaults.string(forKey: key) == "current")
    service.unregisterError = nil
    try await registration.stop()
    #expect(defaults.object(forKey: key) == nil)
  }

  @Test("both code identities and executable or plist changes alter the installation fingerprint")
  func fingerprint() throws {
    func value(
      _ app: String = "app", _ helper: String = "helper", _ code: String = "code",
      _ plist: String = "plist"
    ) throws -> String {
      try DeviceServiceRegistration.fingerprint(
        appRequirement: app, helperRequirement: helper, executable: Data(code.utf8),
        plist: Data(plist.utf8))
    }
    let original = try value()
    #expect(try value() == original)
    #expect(try value("changed") != original)
    #expect(try value("app", "changed") != original)
    #expect(try value("app", "helper", "changed") != original)
    #expect(try value("app", "helper", "code", "changed") != original)
  }
}

@MainActor private final class BackgroundServiceStub: DeviceBackgroundService {
  var status: SMAppService.Status
  var events: [String] = []
  var registerError: DeviceHostError?
  var unregisterError: DeviceHostError?
  var unregisterGate: (() async -> Void)?
  init(status: SMAppService.Status) { self.status = status }
  func register() throws {
    events.append("register")
    if let registerError { throw registerError }
    status = .enabled
  }
  func unregister() async throws {
    events.append("unregister")
    if let unregisterError { throw unregisterError }
    await unregisterGate?()
    status = .notRegistered
  }
}
