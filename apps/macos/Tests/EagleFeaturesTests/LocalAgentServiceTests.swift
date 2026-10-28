import Foundation
import Testing

@testable import EagleFeatures

@Suite("Local Agent process")
struct LocalAgentServiceTests {
  private func fixture(_ source: String) throws -> (URL, LocalAgentService) {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "eagle-process-\(UUID())")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    let cli = root.appendingPathComponent("fixture.mjs")
    try source.write(to: cli, atomically: true, encoding: .utf8)
    let candidates = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map {
      "\($0)/node"
    }
    let node = try #require(
      candidates.first { FileManager.default.isExecutableFile(atPath: $0) },
      "Node.js 24+ is required for Agent process tests")
    return (
      root,
      LocalAgentService(
        node: URL(fileURLWithPath: node), cli: cli,
        config: root.appendingPathComponent("agent.json"))
    )
  }
  private var body: String {
    #"{"label":"ai.hexly.eagle.agent.aaaaaaaaaaaaaaaaaaaaaaaa","installed":true,"loaded":true,"disabled":false,"running":true,"pid":42,"lastExit":null}"#
  }
  private func literal(_ text: String) throws -> String {
    String(decoding: try JSONEncoder().encode(text), as: UTF8.self)
  }

  @Test("real stdout is assembled and stderr is drained without retaining diagnostics")
  func output() async throws {
    let encoded = try literal(body)
    let (root, service) = try fixture(
      "const body=\(encoded); process.stdout.write(body.slice(0,25)); process.stderr.write('isolated-secret'+'e'.repeat(1048576)); setTimeout(()=>process.stdout.write(body.slice(25)),20);"
    )
    defer { try? FileManager.default.removeItem(at: root) }
    let state = try await service.control("status")
    #expect(state.pid == 42 && state.running == true)
    await #expect(throws: LocalAgentError.invalidResponse) { try await service.control("delete") }
    await #expect(throws: LocalAgentError.invalidResponse) {
      try await service.initialize(Data(repeating: 0, count: 65_537))
    }
  }

  @Test("oversized and invalid responses fail closed")
  func invalidOutput() async throws {
    for source in [
      "process.stdout.write('x'.repeat(70000));",
      "process.stdout.write(\(try literal(body.replacingOccurrences(of: "\"pid\":42", with: "\"pid\":0"))));",
      "process.stdout.write('not-json');",
    ] {
      let (root, service) = try fixture(source)
      defer { try? FileManager.default.removeItem(at: root) }
      await #expect(throws: LocalAgentError.invalidResponse) { try await service.control("status") }
    }
  }

  @Test("nonzero exit and a closed stdin do not expose child diagnostic text")
  func earlyExit() async throws {
    let (root, service) = try fixture(
      "process.stderr.write('isolated-process-secret',()=>process.exit(17));")
    defer { try? FileManager.default.removeItem(at: root) }
    await #expect(throws: LocalAgentError.failed(17)) { try await service.control("status") }
    await #expect(throws: LocalAgentError.failed(17)) {
      try await service.initialize(Data(repeating: 88, count: 65_000))
    }
    #expect(!LocalAgentError.failed(17).localizedDescription.contains("isolated-process-secret"))
  }

  @Test("a hanging process has a bounded deadline")
  func deadline() async throws {
    let (root, service) = try fixture("setInterval(()=>{},1000);")
    defer { try? FileManager.default.removeItem(at: root) }
    let started = Date()
    await #expect(throws: LocalAgentError.timedOut) { try await service.control("status") }
    #expect(Date().timeIntervalSince(started) < 20)
  }

  @Test("local file grants use fixed CLI commands and keep folder values on stdin")
  func fileGrants() async throws {
    let (root, service) = try fixture(
      #"""
      const command=process.argv.slice(2).join(' ');
      if(command==='files list') console.log(JSON.stringify({grants:[{id:'fg_fixture',generation:'generation-one',root:'/tmp/folder',name:'Documents'}]}));
      else {let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
        const value=JSON.parse(input);
        if(command==='files grant'&&value.root==='/tmp/folder'&&value.name==='Documents')console.log('{}');
        else if(command==='files revoke'&&value.id==='fg_fixture')console.log('{}');else process.exitCode=9;
      });}
      """#)
    defer { try? FileManager.default.removeItem(at: root) }
    let grants = try await service.fileGrants()
    #expect(grants.count == 1 && grants[0].root == "/tmp/folder")
    try await service.grantDirectory(path: "/tmp/folder", name: "Documents")
    try await service.revokeDirectory(id: "fg_fixture")
    await #expect(throws: LocalAgentError.invalidResponse) {
      try await service.grantDirectory(path: ".", name: "Documents")
    }
    await #expect(throws: LocalAgentError.invalidResponse) {
      try await service.revokeDirectory(id: "not/a/valid/id")
    }
  }

  @Test("identity and stdin use the same installed CLI boundary")
  func identityAndInput() async throws {
    let (root, service) = try fixture(
      #"if(process.argv[2]==='identity')process.stdout.write('{"machineId":"fixture-mac","configured":false}');else{let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',()=>{if(text!=='isolated-input')process.exitCode=17;else process.stdout.write('configured');});}"#
    )
    defer { try? FileManager.default.removeItem(at: root) }
    #expect(try await service.identity().machineId == "fixture-mac")
    try await service.initialize(Data("isolated-input".utf8))
    try "process.stdout.write('{}');".write(to: service.cli, atomically: true, encoding: .utf8)
    await #expect(throws: LocalAgentError.invalidResponse) { try await service.identity() }
  }

  @Test("a saved explicit Node path works with Finder PATH and overrides never fall back")
  func discovery() throws {
    let (root, service) = try fixture("")
    defer { try? FileManager.default.removeItem(at: root) }
    let resources = root.appendingPathComponent("Eagle.app/Contents/Resources")
    let cli = resources.appendingPathComponent(
      "Agent/node_modules/@nocoo/eagle-agent/dist/agent/cli.js")
    try FileManager.default.createDirectory(
      at: cli.deletingLastPathComponent(), withIntermediateDirectories: true)
    try "".write(to: cli, atomically: true, encoding: .utf8)
    let found = try #require(
      LocalAgentService.discover(
        environment: ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"], nodePreference: service.node.path,
        resources: resources, home: root))
    #expect(found.cli == cli && found.node == service.node)
    #expect(
      found.config.path == root.appendingPathComponent(".config/eagle/executor/agent.json").path)
    #expect(
      LocalAgentService.discover(
        environment: ["EAGLE_AGENT_NODE": "/missing/node"], nodePreference: service.node.path,
        resources: resources, home: root) == nil)
    #expect(
      LocalAgentService.discover(
        environment: ["EAGLE_AGENT_NODE": service.node.path, "EAGLE_CONFIG": "relative"],
        resources: resources, home: root) == nil)
    #expect(
      LocalAgentService.discover(
        environment: ["EAGLE_AGENT_NODE": service.node.path, "EAGLE_AGENT_CLI": "/missing/cli"],
        resources: resources, home: root) == nil)
  }

  @Test("unsupported or missing Node is refused before launching the Agent")
  func unsupportedRuntime() async throws {
    let (root, service) = try fixture("process.exit(99);")
    defer { try? FileManager.default.removeItem(at: root) }
    let old = root.appendingPathComponent("old-node")
    try "#!/bin/sh\nprintf 'v23.9.0\\n'\n".write(to: old, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: old.path)
    let unsupported = LocalAgentService(node: old, cli: service.cli, config: service.config)
    await #expect(throws: LocalAgentError.unavailable) { try await unsupported.control("status") }
    let missing = LocalAgentService(
      node: root.appendingPathComponent("absent"), cli: service.cli, config: service.config)
    await #expect(throws: LocalAgentError.unavailable) { try await missing.control("status") }
  }
}
