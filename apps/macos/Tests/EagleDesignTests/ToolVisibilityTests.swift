import Testing

@testable import EagleDesign

@Suite("Transcript tool visibility")
struct ToolVisibilityTests {
  private func sample() -> [TranscriptEntry] {
    let row = ToolRow(id: "tool_1", name: "read", subtitle: "path=notes.txt")
    return [
      .assistant(id: "a1", blocks: [.paragraph("Working")]),
      .tool(id: "tool_1", row: row),
      .user(id: "u1", text: "Next"),
      .toolRun(id: "run_1", rows: [row]),
      .note(id: "n1", text: "已送达", tintIndices: [0]),
    ]
  }

  @Test("hiding tool calls keeps every other row in order")
  func hidesOnlyTools() {
    #expect(sample().hidingToolCalls(true).map(\.id) == ["a1", "u1", "n1"])
  }

  @Test("showing tool calls keeps the transcript untouched")
  func keepsEverything() {
    let entries = sample()
    #expect(entries.hidingToolCalls(false) == entries)
  }

  @Test("only tool rows count as tool calls")
  func classifiesRows() {
    #expect(sample().map(\.isToolCall) == [false, true, false, true, false])
  }
}
