import Combine
import Foundation

/// Owns the local Bots daemon: starts it with the app (unless one is already running),
/// reports its state in Settings, and terminates the process it started when the app quits.
/// It never stops a daemon it did not start, except one a previous run of this app left
/// behind (recognised by the pid it recorded).
private let botsAutoStartKey = "eagle.bots.autoStart"
private let botsDaemonPidKey = "eagle.bots.daemonPid"

@MainActor
public final class BotsDaemonSupervisor: ObservableObject {
  public enum Status: Equatable {
    case stopped
    case starting
    case running(version: String, pid: Int, external: Bool)
    case failed(String)
  }

  @Published public private(set) var status: Status = .stopped
  /// Persisted so the next launch can adopt a daemon an earlier run left after a crash.
  @Published public var autoStart: Bool {
    didSet { UserDefaults.standard.set(autoStart, forKey: botsAutoStartKey) }
  }

  public var rootPath: String { settings.rootPath }
  public var port: String { settings.port }

  private let settings: BotsSettings
  private let daemonDirectory: URL?
  private let nodePath: String?
  private var child: Process?
  /// A daemon this app started earlier (or adopted from its recorded pid); it is ours to stop.
  private var ownedPid: Int?
  private var starting = false
  private let log = LockedText()

  public init(settings: BotsSettings = BotsSettings()) {
    self.settings = settings
    let defaults = UserDefaults.standard
    autoStart = defaults.object(forKey: botsAutoStartKey) as? Bool ?? true
    let environment = ProcessInfo.processInfo.environment
    daemonDirectory = Self.resolveDaemonDirectory(
      explicit: environment["BOTS_DAEMON_DIR"],
      executable: Bundle.main.executableURL
    )
    nodePath = Self.resolveNode(environment: environment)
  }

  /// Starts the daemon if nothing answers the health endpoint. Idempotent.
  public func startIfNeeded() async {
    if case .running = status { return }
    if starting { return }
    if let health = await probe() {
      adopt(health)
      return
    }
    guard autoStart else {
      status = .stopped
      return
    }
    guard let daemonDirectory else {
      status = .failed("找不到 Bots daemon；用 BOTS_DAEMON_DIR 指向 apps/bots。")
      return
    }
    guard let nodePath else {
      status = .failed("需要 Node 24+：没有找到 node 可执行文件。")
      return
    }
    starting = true
    status = .starting
    defer { starting = false }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: nodePath)
    process.arguments = [
      "--experimental-strip-types",
      "--env-file-if-exists=.env",
      "scripts/serve.ts",
      "--root", settings.rootPath,
      "--port", settings.port,
    ]
    process.currentDirectoryURL = daemonDirectory
    let output = Pipe()
    process.standardOutput = output
    process.standardError = output
    output.fileHandleForReading.readabilityHandler = { [log] handle in
      let data = handle.availableData
      if !data.isEmpty { log.append(data) }
    }
    process.terminationHandler = { [weak self] finished in
      Task { @MainActor [weak self] in
        self?.terminated(finished)
      }
    }
    do {
      try process.run()
    } catch {
      output.fileHandleForReading.readabilityHandler = nil
      status = .failed("Bots daemon 启动失败：\(error.localizedDescription)")
      return
    }
    child = process
    ownedPid = Int(process.processIdentifier)
    UserDefaults.standard.set(ownedPid, forKey: botsDaemonPidKey)
    // Wait for health; a daemon with a busy port exits and the probe never answers.
    for _ in 0..<40 {
      try? await Task.sleep(nanoseconds: 250_000_000)
      if let health = await probe() {
        status = .running(version: health.version, pid: health.pid, external: false)
        return
      }
      if !process.isRunning { break }
    }
    let tail = log.suffix(600)
    await terminateChild()
    status = .failed(
      tail.isEmpty ? "Bots daemon 没有在 10 秒内就绪。" : "Bots daemon 退出：\(tail)"
    )
  }

  /// The Settings buttons: stop is synchronous enough for a click; start goes through the
  /// same path as launch.
  public func stop() async {
    if case .running(_, let pid, let external) = status, external {
      status = .failed("这个 daemon 不是由 App 启动的（pid \(pid)），不自动停止。")
      return
    }
    await terminateChild()
    status = .stopped
  }

  public func restart() async {
    await terminateChild()
    status = .stopped
    await startIfNeeded()
  }

  /// `applicationWillTerminate` has little time: signal, wait briefly, then kill. It reads
  /// the pid the supervisor recorded, so it works without touching the main actor.
  public nonisolated static func terminateRecordedDaemon() {
    let pid = UserDefaults.standard.integer(forKey: botsDaemonPidKey)
    guard pid > 0 else { return }
    kill(pid_t(pid), SIGTERM)
    let deadline = Date().addingTimeInterval(3)
    while kill(pid_t(pid), 0) == 0, Date() < deadline { usleep(50_000) }
    if kill(pid_t(pid), 0) == 0 { kill(pid_t(pid), SIGKILL) }
    UserDefaults.standard.removeObject(forKey: botsDaemonPidKey)
  }

  // MARK: - internals

  private struct Health: Decodable {
    let version: String
    let pid: Int
  }

  private func probe() async -> Health? {
    guard let url = URL(string: "http://127.0.0.1:\(settings.port)/v1/health") else {
      return nil
    }
    var request = URLRequest(url: url)
    request.timeoutInterval = 1
    guard let (data, response) = try? await URLSession.shared.data(for: request),
      (response as? HTTPURLResponse)?.statusCode == 200
    else {
      return nil
    }
    return try? JSONDecoder().decode(Health.self, from: data)
  }

  private func adopt(_ health: Health) {
    if let recorded = UserDefaults.standard.object(forKey: botsDaemonPidKey) as? Int,
      recorded == health.pid
    {
      // A previous run of this app spawned it (a crash skipped the shutdown).
      ownedPid = health.pid
      status = .running(version: health.version, pid: health.pid, external: false)
      return
    }
    status = .running(version: health.version, pid: health.pid, external: true)
  }

  private func terminated(_ process: Process) {
    guard child === process else { return }
    child = nil
    ownedPid = nil
    UserDefaults.standard.removeObject(forKey: botsDaemonPidKey)
    if case .starting = status { return }
    if case .stopped = status { return }
    status = .stopped
  }

  private func terminateChild() async {
    guard let process = child, process.isRunning else {
      child = nil
      ownedPid = nil
      UserDefaults.standard.removeObject(forKey: botsDaemonPidKey)
      if case .running(_, _, let external) = status, !external {
        status = .stopped
      }
      return
    }
    process.terminate()
    for _ in 0..<40 {
      if !process.isRunning { break }
      try? await Task.sleep(nanoseconds: 100_000_000)
    }
    if process.isRunning { kill(pid_t(process.processIdentifier), SIGKILL) }
    child = nil
    ownedPid = nil
    UserDefaults.standard.removeObject(forKey: botsDaemonPidKey)
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
  static func resolveNode(environment: [String: String]) -> String? {
    // An explicit path is an instruction, not a hint: a typo must not silently pick
    // another Node that may be the wrong major version.
    if let explicit = environment["BOTS_NODE"] {
      return FileManager.default.isExecutableFile(atPath: explicit) ? explicit : nil
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
