import AppKit
import Foundation

guard CommandLine.arguments.count == 2 else { exit(64) }
let target = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
  .resolvingSymlinksInPath()
guard Bundle(url: target)?.bundleIdentifier == "ai.hexly.eagle.macos.device-candidate" else {
  exit(64)
}
let applications = NSRunningApplication.runningApplications(
  withBundleIdentifier: "ai.hexly.eagle.macos.device-candidate"
).filter { $0.bundleURL?.standardizedFileURL.resolvingSymlinksInPath() == target }
for application in applications { _ = application.terminate() }
let deadline = Date().addingTimeInterval(10)
while applications.contains(where: { !$0.isTerminated }) && Date() < deadline {
  RunLoop.current.run(until: Date().addingTimeInterval(0.05))
}
exit(applications.allSatisfy(\.isTerminated) ? 0 : 1)
