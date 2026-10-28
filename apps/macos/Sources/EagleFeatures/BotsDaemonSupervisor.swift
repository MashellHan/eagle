import Combine
import Foundation

/// Owns the local Bots daemon: starts it with the app (unless one is already running),
/// reports its state in Settings, and terminates the process it started when the app quits.
/// Only a live Process registered by this App is ownership proof. Historical PID
/// preferences never authorize adoption or shutdown after an App restart.
private let botsAutoStartKey = "eagle.bots.autoStart"
private let botsDaemonPidKey = "eagle.bots.daemonPid"
private let botsDaemonProofKey = "eagle.bots.daemonProof"

@MainActor
public final class BotsDaemonSupervisor: ObservableObject {
  public enum Status: Equatable {
    case stopped
    case starting
    case running(version: String, pid: Int, external: Bool)
    case failed(String)
  }

  @Published public private(set) var status: Status = .stopped
  /// Persists the automatic-start preference; a prior process is observed as external.
  @Published public var autoStart: Bool {
    didSet { defaults.set(autoStart, forKey: botsAutoStartKey) }
  }

  public var rootPath: String { settings.rootPath }
  public var port: String { settings.port }

  private let settings: BotsSettings
  private let daemonDirectory: URL?
  private let environment: [String: String]
  private let appBundle: URL
  private let defaults: UserDefaults
  private let loadEnvironmentFile: Bool
  private var control: BotsDaemonControl
  private var observation: AnyCancellable?
  nonisolated private static let ownership = OwnedBotsProcesses()
  var processDidStart: ((Process) -> Void)?

  public init(
    settings: BotsSettings = BotsSettings(),
    environment: [String: String] = ProcessInfo.processInfo.environment,
    executable: URL? = Bundle.main.executableURL,
    defaults: UserDefaults = .standard,
    loadEnvironmentFile: Bool = true
  ) {
    self.settings = settings
    self.defaults = defaults
    self.environment = environment
    self.loadEnvironmentFile = loadEnvironmentFile
    control = BotsDaemonControl.shared(
      context: Self.ownershipContext(root: settings.rootURL, port: settings.port),
      defaults: defaults)
    appBundle =
      executable?.deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent()
      ?? Bundle.main.bundleURL
    autoStart = defaults.object(forKey: botsAutoStartKey) as? Bool ?? true
    daemonDirectory = Self.resolveDaemonDirectory(
      explicit: environment["BOTS_DAEMON_DIR"],
      executable: executable
    )
    observe(control)
  }

  /// Starts the daemon if nothing answers the health endpoint. Concurrent starts share it.
  public func startIfNeeded() async {
    if case .running = status, control.child?.isRunning == true { return }
    guard control.starting == nil else { return }
    control.revision += 1
    let ticket = control.revision
    control.starting = ticket
    let pending = control
    defer { if pending.starting == ticket { pending.starting = nil } }
    if let stopping = control.stopping { _ = await stopping.task.value }
    guard ticket == control.revision else { return }
    await start(ticket: ticket)
  }

  private func start(ticket: Int) async {
    let health = await probe()
    guard ticket == control.revision else { return }
    if let health {
      adopt(health)
      return
    }
    control.externalPID = nil
    guard autoStart else {
      control.status = .stopped
      return
    }
    guard let daemonDirectory else {
      control.status = .failed("找不到 Bots daemon；用 BOTS_DAEMON_DIR 指向 apps/bots。")
      return
    }
    guard
      let nodePath = Self.resolveNode(
        environment: environment,
        preference: defaults.string(forKey: "eagle.machine-agent.nodePath"))
    else {
      control.status = .failed("需要 Node 24+：请在机器设置中选择 node 可执行文件。")
      return
    }
    control.status = .starting
    do {
      let bytes = try await Task.detached(priority: .userInitiated) {
        try LocalPrivateProcess.runBlocking(
          executable: URL(fileURLWithPath: nodePath),
          arguments: ["--version"], environment: ["PATH": "/usr/bin:/bin"], input: Data())
      }.value
      guard ticket == control.revision else { return }
      let value = String(decoding: bytes, as: UTF8.self).trimmingCharacters(
        in: .whitespacesAndNewlines)
      guard value.hasPrefix("v"),
        let major = Int(value.dropFirst().split(separator: ".").first ?? ""), major >= 24
      else {
        control.status = .failed("所选 Node 版本低于 24；请在机器设置中重新选择。")
        return
      }
    } catch {
      if ticket == control.revision {
        control.status = .failed("无法验证所选 Node；请在机器设置中重新选择。")
      }
      return
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: nodePath)
    process.arguments =
      ["--experimental-strip-types"]
      + (loadEnvironmentFile ? ["--env-file-if-exists=.env"] : [])
      + ["scripts/serve.ts", "--root", settings.rootPath, "--port", settings.port]
    process.currentDirectoryURL = daemonDirectory
    var childEnvironment = environment
    childEnvironment["BOTS_CREDENTIAL_HELPER"] =
      BotCredentialHelper.discover(environment: environment, bundle: appBundle)?.executable.path
    process.environment = childEnvironment
    process.standardInput = FileHandle.nullDevice
    let output = Pipe()
    process.standardOutput = output
    process.standardError = output
    output.fileHandleForReading.readabilityHandler = { [log = control.log] handle in
      let data = handle.availableData
      if !data.isEmpty { log.append(data) }
    }
    process.terminationHandler = { [control] finished in
      output.fileHandleForReading.readabilityHandler = nil
      Self.ownership.remove(finished)
      Task { @MainActor in control.terminated(finished) }
    }
    do { try process.run() } catch {
      output.fileHandleForReading.readabilityHandler = nil
      control.status = .failed("Bots daemon 启动失败：\(error.localizedDescription)")
      return
    }
    control.child = process
    Self.ownership.register(process, control: control, defaults: defaults)
    processDidStart?(process)
    for _ in 0..<40 {
      try? await Task.sleep(for: .milliseconds(250))
      guard ticket == control.revision else { return }
      let observed = await probe()
      guard ticket == control.revision else { return }
      if let observed {
        if observed.pid != Int(process.processIdentifier) {
          _ = await terminateChild(process)
          guard ticket == control.revision else { return }
          adopt(observed)
          return
        }
        if process.isRunning, control.child === process {
          Self.ownership.claim(process)
          control.status = .running(version: observed.version, pid: observed.pid, external: false)
          return
        }
      }
      if !process.isRunning { break }
    }
    let tail = control.log.suffix(600)
    _ = await terminateChild(process)
    guard ticket == control.revision else { return }
    control.status = .failed(tail.isEmpty ? "Bots daemon 没有在 10 秒内就绪。" : "Bots daemon 退出：\(tail)")
  }

  public func stop() async {
    control.revision += 1
    let ticket = control.revision
    control.starting = nil
    if let externalPID = control.externalPID, control.child == nil {
      control.status = .failed("这个 daemon 不是由 App 启动的（pid \(externalPID)），不自动停止。")
      return
    }
    let stopped = await terminateChild()
    guard ticket == control.revision else { return }
    control.status = stopped ? .stopped : .failed("尚未确认 Bots daemon 已停止。")
  }

  public func restart() async {
    control.revision += 1
    let ticket = control.revision
    control.starting = ticket
    let pending = control
    defer { if pending.starting == ticket { pending.starting = nil } }
    if let externalPID = control.externalPID, control.child == nil {
      control.status = .failed("这个 daemon 不是由 App 启动的（pid \(externalPID)），不自动重启。")
      return
    }
    let stopped = await terminateChild()
    guard ticket == control.revision else { return }
    guard stopped else {
      control.status = .failed("尚未确认 Bots daemon 已停止。")
      return
    }
    control.status = .stopped
    await start(ticket: ticket)
  }

  /// Only current App-owned Process handles may be signalled. Preferences from an
  /// earlier App process cannot prove ownership, even if a PID has been reused.
  public nonisolated static func terminateRecordedDaemon(defaults: UserDefaults = .standard) {
    ownership.terminate(defaults: defaults)
  }

  /// POSIX realpath does not abbreviate /private/var like Foundation can after
  /// a previously absent URL is created. Resolve the existing ancestor once and
  /// append the missing suffix using strings, preserving that canonical spelling.
  private static func ownershipContext(root: URL, port: String) -> String {
    var ancestor = root.standardizedFileURL.path
    var missing: [String] = []
    while true {
      if let resolved = realpath(ancestor, nil) {
        defer { free(resolved) }
        let base = String(cString: resolved)
        let suffix = missing.reversed().joined(separator: "/")
        let path = suffix.isEmpty ? base : (base == "/" ? "/" : base + "/") + suffix
        return path + "\u{0}" + port
      }
      let parent = (ancestor as NSString).deletingLastPathComponent
      guard !parent.isEmpty, parent != ancestor else {
        return root.standardizedFileURL.path + "\u{0}" + port
      }
      missing.append((ancestor as NSString).lastPathComponent)
      ancestor = parent
    }
  }
  private struct Health: Decodable {
    let version: String
    let pid: Int
  }

  private func probe() async -> Health? {
    guard let url = URL(string: "http://127.0.0.1:\(settings.port)/v1/health") else { return nil }
    var request = URLRequest(url: url)
    request.timeoutInterval = 1
    guard let (data, response) = try? await URLSession.shared.data(for: request),
      (response as? HTTPURLResponse)?.statusCode == 200,
      let health = try? JSONDecoder().decode(Health.self, from: data),
      health.pid > 0, health.pid <= Int(Int32.max), !health.version.isEmpty
    else { return nil }
    return health
  }

  private func adopt(_ health: Health) {
    if let owned = Self.ownership.find(
      pid: health.pid, context: control.context, defaults: defaults)
    {
      observe(owned.control)
      control.child = owned.process
      control.externalPID = nil
      Self.ownership.claim(owned.process)
      control.status = .running(version: health.version, pid: health.pid, external: false)
    } else {
      control.child = nil
      control.externalPID = health.pid
      control.status = .running(version: health.version, pid: health.pid, external: true)
    }
  }

  private func observe(_ shared: BotsDaemonControl) {
    control = shared
    observation = shared.$status.sink { [weak self] in self?.status = $0 }
  }

  private func terminateChild(_ selected: Process? = nil) async -> Bool {
    guard let process = selected ?? control.child else { return true }
    if let stopping = control.stopping, stopping.process === process {
      return await stopping.task.value
    }
    let task = Task { @MainActor [control] in
      if process.isRunning {
        process.terminate()
        for _ in 0..<40 where process.isRunning { try? await Task.sleep(for: .milliseconds(100)) }
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        for _ in 0..<10 where process.isRunning { try? await Task.sleep(for: .milliseconds(100)) }
      }
      guard !process.isRunning else { return false }
      Self.ownership.remove(process)
      if control.child === process { control.child = nil }
      return true
    }
    control.stopping = (process, task)
    let stopped = await task.value
    if control.stopping?.process === process { control.stopping = nil }
    return stopped
  }

  /// `apps/bots` from the executable's ancestry, so a built `.app` in the repo finds the
  /// daemon without configuration; an explicit environment path wins.
  static func resolveDaemonDirectory(explicit: String?, executable: URL?) -> URL? {
    let fileManager = FileManager.default
    if let explicit, !explicit.isEmpty {
      let url = URL(fileURLWithPath: explicit, isDirectory: true)
      if fileManager.fileExists(atPath: url.appendingPathComponent("scripts/serve.ts").path) {
        return url
      }
      return nil
    }
    if let contents = executable?.deletingLastPathComponent().deletingLastPathComponent() {
      let bundled = contents.appendingPathComponent("Resources/Bots", isDirectory: true)
      if fileManager.fileExists(atPath: bundled.appendingPathComponent("scripts/serve.ts").path) {
        return bundled
      }
    }
    var directory = executable?.deletingLastPathComponent()
    for _ in 0..<8 {
      guard let current = directory else { return nil }
      let candidate = current.appendingPathComponent("apps/bots", isDirectory: true)
      if fileManager.fileExists(atPath: candidate.appendingPathComponent("scripts/serve.ts").path) {
        return candidate
      }
      directory = current.deletingLastPathComponent()
    }
    return nil
  }

  /// A GUI app's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`; Homebrew's node is not on it.
  static func resolveNode(environment: [String: String], preference: String? = nil) -> String? {
    // An explicit path is an instruction, not a hint: a typo must not silently pick
    // another Node that may be the wrong major version.
    if let explicit = environment["BOTS_NODE"] {
      return explicit.hasPrefix("/") && FileManager.default.isExecutableFile(atPath: explicit)
        ? explicit : nil
    }
    if let preference {
      return preference.hasPrefix("/") && FileManager.default.isExecutableFile(atPath: preference)
        ? preference : nil
    }
    for candidate in [
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "/usr/bin/node",
    ] where FileManager.default.isExecutableFile(atPath: candidate) {
      return candidate
    }
    if let path = environment["PATH"] {
      for directory in path.split(separator: ":") {
        let candidate = "\(directory)/node"
        if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
      }
    }
    return nil
  }
}

/// Windows sharing preferences and a canonical root/port use one lifecycle. Weak
/// caching keeps a closed fixture or window from owning state forever; a live
/// child is retained separately in OwnedBotsProcesses until it actually exits.
@MainActor
private final class BotsDaemonControl: ObservableObject {
  private final class WeakControl {
    weak var value: BotsDaemonControl?
    init(_ value: BotsDaemonControl) { self.value = value }
  }
  private static var contexts: [String: [WeakControl]] = [:]
  let context: String
  let defaults: UserDefaults
  @Published var status: BotsDaemonSupervisor.Status = .stopped
  var child: Process?
  var externalPID: Int?
  var revision = 0
  var starting: Int?
  var stopping: (process: Process, task: Task<Bool, Never>)?
  let log = LockedText()

  private init(context: String, defaults: UserDefaults) {
    self.context = context
    self.defaults = defaults
  }

  static func shared(context: String, defaults: UserDefaults) -> BotsDaemonControl {
    let live = (contexts[context] ?? []).compactMap(\.value)
    if let shared = live.first(where: { $0.defaults === defaults }) { return shared }
    let shared = BotsDaemonControl(context: context, defaults: defaults)
    contexts[context] = (live + [shared]).map(WeakControl.init)
    return shared
  }

  func terminated(_ process: Process) {
    guard child === process else { return }
    child = nil
    if case .starting = status { return }
    if stopping?.process === process { return }
    status = .stopped
  }
}

/// A receipt only selects an entry in this process-local registry. It cannot recreate
/// ownership after restart. The lock also protects conditional receipt removal.
private final class OwnedBotsProcesses: @unchecked Sendable {
  private struct Entry {
    let id = UUID().uuidString
    let process: Process
    let context: String
    let control: BotsDaemonControl
    let defaults: UserDefaults
  }
  private let lock = NSLock()
  private var entries: [ObjectIdentifier: Entry] = [:]

  @MainActor
  func register(_ process: Process, control: BotsDaemonControl, defaults: UserDefaults) {
    let context = control.context
    lock.withLock {
      entries[ObjectIdentifier(process)] = Entry(
        process: process, context: context, control: control, defaults: defaults)
    }
  }
  private func matches(_ entry: Entry, defaults: UserDefaults) -> Bool {
    entry.defaults === defaults
      || (defaults.string(forKey: botsDaemonProofKey) == entry.id
        && defaults.integer(forKey: botsDaemonPidKey) == Int(entry.process.processIdentifier))
  }
  func find(
    pid: Int, context: String, defaults: UserDefaults
  ) -> (
    process: Process, control: BotsDaemonControl
  )? {
    lock.withLock {
      guard
        let entry = entries.values.first(where: { entry in
          entry.context == context && Int(entry.process.processIdentifier) == pid
            && entry.process.isRunning && matches(entry, defaults: defaults)
        })
      else { return nil }
      return (entry.process, entry.control)
    }
  }
  func claim(_ process: Process) {
    lock.withLock {
      guard let entry = entries[ObjectIdentifier(process)], process.isRunning else { return }
      entry.defaults.set(Int(process.processIdentifier), forKey: botsDaemonPidKey)
      entry.defaults.set(entry.id, forKey: botsDaemonProofKey)
    }
  }
  func remove(_ process: Process) {
    lock.withLock {
      guard !process.isRunning, let entry = entries.removeValue(forKey: ObjectIdentifier(process))
      else { return }
      if entry.defaults.string(forKey: botsDaemonProofKey) == entry.id,
        entry.defaults.integer(forKey: botsDaemonPidKey) == Int(process.processIdentifier)
      {
        entry.defaults.removeObject(forKey: botsDaemonPidKey)
        entry.defaults.removeObject(forKey: botsDaemonProofKey)
      }
    }
  }
  func terminate(defaults: UserDefaults) {
    let owned = lock.withLock {
      entries.values.filter { matches($0, defaults: defaults) }.map(\.process)
    }
    for process in owned where process.isRunning { process.terminate() }
    let deadline = Date().addingTimeInterval(3)
    while owned.contains(where: \.isRunning), Date() < deadline { usleep(50_000) }
    for process in owned {
      if process.isRunning { kill(process.processIdentifier, SIGKILL) }
      remove(process)
    }
  }
}

/// A tiny thread-safe tail buffer for the child's output, read on a background queue.
private final class LockedText: @unchecked Sendable {
  private let lock = NSLock()
  private var text = ""

  func append(_ data: Data) {
    guard let piece = String(data: data, encoding: .utf8) else { return }
    lock.lock()
    text += piece
    if text.count > 4_000 { text = String(text.suffix(4_000)) }
    lock.unlock()
  }

  func suffix(_ count: Int) -> String {
    lock.lock()
    defer { lock.unlock() }
    return String(text.suffix(count)).trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
