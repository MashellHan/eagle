import EagleDevices
import Testing

@testable import EagleFeatures

@Suite("Device approval presentation")
struct DeviceApprovalPresentationTests {
  @Test("command summary includes full command, directory and timeout")
  func command() {
    let summary = DeviceApprovalPresentation(
      operation: .object([
        "kind": .string("command"), "command": .string("printf '你好'\nrm output.txt"),
        "cwd": .string("/Users/test/My Project"), "timeoutMs": .number(45000),
      ]))
    #expect(summary.title == "执行命令")
    #expect(
      summary.fields.map(\.value) == [
        "printf '你好'\nrm output.txt", "/Users/test/My Project", "45000 毫秒",
      ])
  }

  @Test("write summary keeps the entire path and content")
  func fileWrite() {
    let content = String(repeating: "修改后的内容\n", count: 1000)
    let summary = DeviceApprovalPresentation(
      operation: .object([
        "kind": .string("file.write"), "path": .string("/Users/test/config.json"),
        "content": .string(content),
      ]))
    #expect(summary.title == "写入文件")
    #expect(summary.fields.map(\.value) == ["/Users/test/config.json", content])
  }

  @Test("native summary retains every argument including nested values")
  func native() {
    let summary = DeviceApprovalPresentation(
      operation: .object([
        "kind": .string("native"), "tool": .string("edit"),
        "args": .object([
          "path": .string("/a"), "oldText": .string("before"), "newText": .string("after"),
          "options": .object(["all": .bool(true)]),
        ]),
        "cwd": .string("/working"),
      ]))
    #expect(summary.fields.first?.value == "edit")
    let args = summary.fields[1].value
    #expect(
      args.contains("before") && args.contains("after") && args.contains("true")
        && args.contains("/a"))
    #expect(summary.fields.last?.value == "/working")
  }

  @Test("unknown operation fields remain visible instead of disappearing")
  func unknownField() {
    let summary = DeviceApprovalPresentation(
      operation: .object([
        "kind": .string("file.read"), "path": .string("/a"), "futureOption": .bool(true),
      ]))
    #expect(summary.fields.contains { $0.title == "futureOption" && $0.value == "true" })
  }
}
