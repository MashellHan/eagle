import Foundation
import Testing

private let remoteCoverageFiles = [
  "BotsCore/Domain/RemoteTools.swift",
  "BotsTransport/RemoteToolsHTTPClient.swift",
]

@Suite("Native coverage gate") struct CoverageGateTests {
  @Test func completeReportIncludesConsumerLogic() throws {
    let result = try runGate()
    #expect(result.status == 0, "\(result.output)")
    #expect(result.output.contains("coverage: 310/310 lines = 100.0% (minimum 90.0%)"))
  }

  @Test(arguments: remoteCoverageFiles)
  func missingConsumerLogicFails(_ file: String) throws {
    let result = try runGate(omitting: file)
    #expect(result.status != 0, "Missing \(file) must not pass: \(result.output)")
    #expect(result.output.contains("coverage: missing consumer logic \(file)"))
  }

  @Test(arguments: remoteCoverageFiles)
  func uncoveredConsumerLogicCountsAgainstTheFloor(_ file: String) throws {
    let result = try runGate(uncovered: file)
    #expect(result.status != 0, "Uncovered \(file) must count: \(result.output)")
    #expect(result.output.contains("coverage: 210/310 lines = 67.7% (minimum 90.0%)"))
    #expect(result.output.contains("coverage below threshold"))
  }

  @Test(arguments: ["macos", "bots-macos"])
  func scratchPathsWithSpacesKeepTheReportAndAreRemoved(_ package: String) throws {
    let result = try runGate(packageName: package, temporaryName: "temporary directory with spaces")
    #expect(result.status == 0, "\(result.output)")
    let lines = package == "macos" ? 310 : 100
    #expect(
      result.output.contains("coverage: \(lines)/\(lines) lines = 100.0% (minimum 90.0%)"))
    #expect(result.temporaryEntries.isEmpty)
  }

  private func runGate(
    omitting: String? = nil, uncovered: String? = nil,
    packageName: String = "macos", temporaryName: String = "tmp"
  ) throws -> (
    status: Int32, output: String, temporaryEntries: [String]
  ) {
    let files = FileManager.default
    let root = files.temporaryDirectory.appendingPathComponent(
      "eagle-coverage-gate-\(UUID().uuidString)")
    try files.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? files.removeItem(at: root) }

    func write(_ path: String, _ contents: String, executable: Bool = false) throws {
      let url = root.appendingPathComponent(path)
      try files.createDirectory(
        at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      try Data(contents.utf8).write(to: url)
      if executable { try files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path) }
    }

    let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent(packageName)
    try write(
      "apps/\(packageName)/Scripts/coverage.sh",
      String(contentsOf: package.appendingPathComponent("Scripts/coverage.sh"), encoding: .utf8))
    try write("apps/macos/Sources/EagleFeatures/Machines/CoverageMachine.swift", "// fixture\n")
    try write(
      "scripts/swift-gate.sh",
      """
      #!/bin/sh
      set -eu
      [ "$1" = test ]
      [ "$2" = --scratch-path ]
      [ "$4" = --enable-code-coverage ]
      mkdir -p "$3/Fixture.xctest/Contents/MacOS"
      : > "$3/default.profdata"
      : > "$3/Fixture.xctest/Contents/MacOS/Fixture"
      chmod 700 "$3/Fixture.xctest/Contents/MacOS/Fixture"
      """, executable: true)
    try write(
      "bin/xcrun",
      """
      #!/bin/sh
      set -eu
      [ "$1" = llvm-cov ]
      [ "$2" = report ]
      cat "$EAGLE_TEST_COVERAGE_REPORT"
      """, executable: true)

    func row(_ path: String, lines: Int = 100, missed: Int = 0) -> String {
      "\(path) 1 0 100% 1 0 100% \(lines) \(missed) \((lines - missed) * 100 / lines)%\n"
    }
    var report = row("Sources/EagleFeatures/WorkspaceViewModels.swift")
    report += row("Sources/EagleFeatures/Machines/CoverageMachine.swift", lines: 10)
    for file in remoteCoverageFiles where file != omitting {
      report += row("../bots-macos/Sources/\(file)", missed: file == uncovered ? 100 : 0)
    }
    if packageName == "bots-macos" { report = row("Sources/BotsCore/Logic/Reducer.swift") }
    try write("report.txt", report)
    try files.createDirectory(
      at: root.appendingPathComponent(temporaryName), withIntermediateDirectories: true)

    let process = Process()
    let output = Pipe()
    process.executableURL = URL(fileURLWithPath: "/bin/sh")
    process.arguments = [
      root.appendingPathComponent("apps/\(packageName)/Scripts/coverage.sh").path
    ]
    process.environment = [
      "PATH": "\(root.path)/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      "TMPDIR": root.appendingPathComponent(temporaryName).path,
      "EAGLE_TEST_COVERAGE_REPORT": root.appendingPathComponent("report.txt").path,
    ]
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = output
    process.standardError = output
    try process.run()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return (
      process.terminationStatus, String(decoding: data, as: UTF8.self),
      try files.contentsOfDirectory(atPath: root.appendingPathComponent(temporaryName).path)
    )
  }
}
