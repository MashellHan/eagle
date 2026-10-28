import Foundation
import Testing

@testable import EagleFeatures

@MainActor
private final class SupervisorFixture {
  let root: URL
  let domain = "ai.hexly.eagle.supervisor-test.\(UUID().uuidString)"
  let defaults: UserDefaults
  let node: URL
  var environment: [String: String]
  var processes: [Process] = []
  var controllers: [BotsDaemonSupervisor] = []

  init(mode: String = "normal", stopDelay: Int = 0) throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "eagle-supervisor-\(UUID())")
    defaults = try #require(UserDefaults(suiteName: domain))
    let path = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":")
    node = URL(
      fileURLWithPath: try #require(
        path.map { "\($0)/node" }.first {
          FileManager.default.isExecutableFile(atPath: $0)
        }))
    try FileManager.default.createDirectory(
      at: root.appendingPathComponent("scripts"), withIntermediateDirectories: true)
    let port = try LocalPrivateProcess.runBlocking(
      executable: node,
      arguments: [
        "-e",
        "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()});",
      ],
      environment: ["PATH": "/usr/bin:/bin"], input: Data())
    environment = [
      "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "BOTS_NODE": node.path,
      "BOTS_ROOT": root.appendingPathComponent("state").path,
      "BOTS_PORT": String(decoding: port, as: UTF8.self),
      "BOTS_DAEMON_DIR": root.path, "XDG_CONFIG_HOME": root.appendingPathComponent("config").path,
      "FIXTURE_ROOT": root.path, "FIXTURE_MODE": mode, "FIXTURE_STOP_DELAY": String(stopDelay),
    ]
    try #"""
    import {createServer} from 'node:http';
    import {appendFileSync, writeFileSync, mkdirSync} from 'node:fs';
    import {join} from 'node:path';
    mkdirSync(process.env.BOTS_ROOT,{recursive:true});
    if(process.env.EAGLE_DOTENV_ONLY){
      writeFileSync(join(process.env.FIXTURE_ROOT,'dotenv-loaded'),'yes');
    }
    let requests=0, stopping=false;
    const server=createServer((request,response)=>{
      if(request.url!=='/v1/health'){response.writeHead(404).end();return;}
      if(process.env.FIXTURE_MODE==='race' && ++requests===1){response.writeHead(503).end();return;}
      response.setHeader('content-type','application/json');
      response.end(JSON.stringify({version:'fixture',pid:process.pid}));
    });
    server.on('error',()=>process.exit(1));
    server.listen(Number(process.env.BOTS_PORT),'127.0.0.1',()=>{
      appendFileSync(join(process.env.FIXTURE_ROOT,'starts'),process.pid+'\n');
    });
    process.on('SIGTERM',()=>{
      if(stopping)return;stopping=true;
      writeFileSync(join(process.env.FIXTURE_ROOT,'terminating'),'yes');
      setTimeout(()=>server.close(()=>process.exit(0)),Number(process.env.FIXTURE_STOP_DELAY));
    });
    """#.write(
      to: root.appendingPathComponent("scripts/serve.ts"), atomically: true, encoding: .utf8)
  }

  func controller(loadEnvironmentFile: Bool = true) -> BotsDaemonSupervisor {
    let value = BotsDaemonSupervisor(
      settings: BotsSettings(environment: environment),
      environment: environment, executable: nil, defaults: defaults,
      loadEnvironmentFile: loadEnvironmentFile)
    value.processDidStart = { [weak self] process in self?.processes.append(process) }
    controllers.append(value)
    return value
  }

  func unrelatedProcess() throws -> Process {
    let process = Process()
    process.executableURL = node
    process.arguments = ["-e", "setInterval(()=>{},1000)"]
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    processes.append(process)
    return process
  }

  func startForeign() throws -> Process {
    let process = Process()
    process.executableURL = node
    process.arguments = [root.appendingPathComponent("scripts/serve.ts").path]
    process.environment = environment
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    processes.append(process)
    return process
  }

  var starts: Int {
    (try? String(contentsOf: root.appendingPathComponent("starts"), encoding: .utf8))?
      .split(separator: "\n").count ?? 0
  }

  func listening() async -> Bool {
    let url = URL(string: "http://127.0.0.1:\(environment["BOTS_PORT"]!)/v1/health")!
    var request = URLRequest(url: url)
    request.timeoutInterval = 1
    guard let (_, response) = try? await URLSession.shared.data(for: request) else { return false }
    return (response as? HTTPURLResponse)?.statusCode == 200
  }

  func until(_ condition: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(5)
    while !condition() {
      guard Date() < deadline else { throw URLError(.timedOut) }
      try await Task.sleep(for: .milliseconds(10))
    }
  }

  func close() async {
    for controller in controllers { await controller.stop() }
    for process in processes where process.isRunning {
      process.terminate()
      for _ in 0..<20 where process.isRunning { try? await Task.sleep(for: .milliseconds(50)) }
      if process.isRunning { kill(process.processIdentifier, SIGKILL) }
    }
    defaults.removePersistentDomain(forName: domain)
    try? FileManager.default.removeItem(at: root)
  }
}

@MainActor
@Suite("Bots daemon lifecycle ownership", .serialized)
struct BotsDaemonLifecycleTests {
  private func fixture(
    mode: String = "normal", stopDelay: Int = 0,
    _ body: (SupervisorFixture) async throws -> Void
  ) async throws {
    let value = try SupervisorFixture(mode: mode, stopDelay: stopDelay)
    do { try await body(value) } catch {
      await value.close()
      throw error
    }
    await value.close()
  }

  @Test(arguments: [false, true])
  func environmentFileLoadingFollowsTheExplicitHostChoice(_ loadEnvironment: Bool) async throws {
    try await fixture { value in
      try "EAGLE_DOTENV_ONLY=verification-fixture\n".write(
        to: value.root.appendingPathComponent(".env"), atomically: true, encoding: .utf8)
      let controller = value.controller(loadEnvironmentFile: loadEnvironment)
      await controller.startIfNeeded()
      #expect(await value.listening())
      #expect(
        FileManager.default.fileExists(
          atPath: value.root.appendingPathComponent("dotenv-loaded").path)
          == loadEnvironment)
    }
  }

  @Test func historicalPIDCannotAuthorizeShutdownOfAnUnrelatedProcess() async throws {
    try await fixture { value in
      let unrelated = try value.unrelatedProcess()
      value.defaults.set(Int(unrelated.processIdentifier), forKey: "eagle.bots.daemonPid")
      BotsDaemonSupervisor.terminateRecordedDaemon(defaults: value.defaults)
      #expect(unrelated.isRunning, "an old PID receipt alone is not ownership proof")
    }
  }

  @Test func sharedPreferencesControllerStopsTheActualOwnedChild() async throws {
    try await fixture { value in
      let first = value.controller()
      await first.startIfNeeded()
      #expect(await value.listening())
      let second = value.controller()
      await second.startIfNeeded()
      await second.stop()
      #expect(
        !(await value.listening()),
        "a controller cannot report stopped while its adopted daemon serves")
      #expect(value.processes.allSatisfy { !$0.isRunning })
      #expect(second.status == .stopped)
      #expect(value.defaults.object(forKey: "eagle.bots.daemonPid") == nil)
    }
  }

  @Test func aPortRaceNeverLabelsTheForeignHealthPIDAsOwned() async throws {
    try await fixture(mode: "race") { value in
      let foreign = try value.startForeign()
      try await value.until { value.starts == 1 }
      let controller = value.controller()
      await controller.startIfNeeded()
      #expect(
        controller.status
          == .running(version: "fixture", pid: Int(foreign.processIdentifier), external: true))
      await controller.stop()
      #expect(foreign.isRunning)
      #expect(value.defaults.object(forKey: "eagle.bots.daemonPid") == nil)
    }
  }

  @Test func theLatestStopSupersedesAnAwaitingRestart() async throws {
    try await fixture(stopDelay: 600) { value in
      let controller = value.controller()
      await controller.startIfNeeded()
      #expect(await value.listening())
      let restarting = Task { await controller.restart() }
      try await value.until {
        FileManager.default.fileExists(
          atPath: value.root.appendingPathComponent("terminating").path)
      }
      await controller.stop()
      await restarting.value
      #expect(controller.status == .stopped)
      #expect(value.starts == 1, "the superseded restart must not spawn another process")
      #expect(!(await value.listening()))
      #expect(value.processes.allSatisfy { !$0.isRunning })
    }
  }

  @Test func controllersShareOneControlGeneration() async throws {
    try await fixture(stopDelay: 600) { value in
      try FileManager.default.createDirectory(
        atPath: value.environment["BOTS_ROOT"]!, withIntermediateDirectories: true)
      let first = value.controller()
      await first.startIfNeeded()
      let second = value.controller()
      await second.startIfNeeded()
      let restarting = Task { await first.restart() }
      try await value.until {
        FileManager.default.fileExists(
          atPath: value.root.appendingPathComponent("terminating").path)
      }
      await second.stop()
      await restarting.value
      #expect(second.status == .stopped)
      #expect(value.starts == 1, "another window's last stop must invalidate the restart")
      #expect(!(await value.listening()))
    }
  }

  @Test func peerExitUpdatesEveryControllerWithoutAnotherButtonClick() async throws {
    try await fixture { value in
      try FileManager.default.createDirectory(
        atPath: value.environment["BOTS_ROOT"]!, withIntermediateDirectories: true)
      let first = value.controller()
      await first.startIfNeeded()
      let second = value.controller()
      await second.startIfNeeded()
      await first.stop()
      try await value.until { second.status == .stopped }
      #expect(!value.processes.contains { $0.isRunning })
    }
  }

  @Test func aNewRootAndItsSymlinkAliasKeepTheSameOwner() async throws {
    try await fixture { value in
      let real = value.root.appendingPathComponent("real-parent")
      let alias = value.root.appendingPathComponent("link-parent")
      try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
      try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: real)
      value.environment["BOTS_ROOT"] = alias.appendingPathComponent("new-state").path
      let first = value.controller()
      await first.startIfNeeded()
      value.environment["BOTS_ROOT"] = real.appendingPathComponent("new-state").path
      let second = value.controller()
      await second.startIfNeeded()
      if case .running(_, _, let external) = second.status {
        #expect(!external)
      } else {
        Issue.record("the real fixture daemon must be observed")
      }
      await second.stop()
      #expect(!(await value.listening()))
    }
  }
}
