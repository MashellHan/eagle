import Foundation

@main
enum NativeAgentServiceProbe {
  static func main() async {
    do { try await run() } catch {
      FileHandle.standardError.write(Data("Native Agent operation failed\n".utf8))
      exit(1)
    }
  }
  static func run() async throws {
    let args = CommandLine.arguments
    let service = LocalAgentService(
      node: URL(fileURLWithPath: args[1]), cli: URL(fileURLWithPath: args[2]),
      config: URL(fileURLWithPath: args[3]))
    if args[4] == "initialize" || args[4] == "reconfigure" {
      let data = FileHandle.standardInput.readDataToEndOfFile()
      if args[4] == "initialize" {
        try await service.initialize(data)
      } else {
        try await service.reconfigure(data)
      }
      print("configured")
    } else {
      let state = try await service.control(args[4])
      print(String(decoding: try JSONEncoder().encode(state), as: UTF8.self))
    }
  }
}
