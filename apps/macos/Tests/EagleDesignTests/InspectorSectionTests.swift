import Testing

@testable import EagleDesign

@Suite("Inspector section assembly")
struct InspectorSectionTests {
  private let artifacts = [
    InspectorArtifact(id: "a1", title: "deps 2026-10-24 sleepy"),
    InspectorArtifact(id: "a2", title: "deps 2026-10-24 next-ai"),
  ]
  private let jobs = [
    InspectorJob(id: "j1", title: "每日依赖修复调度", detail: "每天 8:47", isOn: true)
  ]
  private let tasks = [
    InspectorTaskRow(
      id: "t_12", title: "生成回答", symbolName: "sparkles", status: "运行中", depth: 0,
      isRunning: true, isBlocked: false),
    InspectorTaskRow(
      id: "t_13", title: "工具调用", symbolName: "wrench.and.screwdriver", status: "等待",
      depth: 1, isRunning: false, isBlocked: false),
  ]

  @Test("the detail tab is 模型, 编码, 例行任务, 任务, 用量 — always all five, in that order")
  func detailOrder() {
    let usage = [
      InspectorUsageRow(id: "input", label: "输入", value: "12.3k"),
      InspectorUsageRow(id: "cost", label: "花费", value: "$0.42"),
    ]
    let choices = [
      InspectorChoiceRow(
        id: "model", label: "模型", value: "auto/gpt-6-luna", selected: "auto/gpt-6-luna",
        choices: [.init(id: "auto/gpt-6-luna", title: "auto/gpt-6-luna")])
    ]
    let sections = InspectorSections.detail(
      artifacts: artifacts, jobs: jobs, tasks: tasks, usage: usage, choices: choices)
    #expect(sections.map(\.title) == ["模型", "编码", "例行任务", "任务", "用量"])
    #expect(sections.map(\.id).count == Set(sections.map(\.id)).count)
    #expect(sections.allSatisfy { !$0.symbolName.isEmpty }, "every section header carries a glyph")
    #expect(sections.allSatisfy { !$0.isEmpty })
    guard case .choices(let rows) = sections[0].rows else {
      Issue.record("the first section holds the agent choices")
      return
    }
    #expect(rows == choices)
    guard case .tasks(let taskRows) = sections[3].rows else {
      Issue.record("the fourth section holds the tasks")
      return
    }
    #expect(taskRows == tasks)
    guard case .usage(let figures) = sections[4].rows else {
      Issue.record("the last section holds the usage")
      return
    }
    #expect(figures == usage)
  }

  @Test("an empty section keeps its header and carries an icon, a line and a sentence")
  func emptySections() {
    let sections = InspectorSections.detail(
      artifacts: [], jobs: [], tasks: [], usage: [])
    #expect(
      sections.map(\.title) == ["模型", "编码", "例行任务", "任务", "用量"],
      "a section never disappears")
    #expect(sections.allSatisfy { $0.isEmpty })
    #expect(
      sections.map(\.placeholder.title)
        == ["这个会话没有模型", "还没有产物", "没有例行任务", "没有正在运行的任务", "还没有用量"])
    #expect(sections.allSatisfy { !$0.placeholder.symbolName.isEmpty })
    #expect(sections.allSatisfy { !$0.placeholder.detail.isEmpty })
    #expect(sections[3].placeholder.title == "没有正在运行的任务")
  }

  @Test("the library and computer tabs are decorated sections too")
  func libraryAndComputer() {
    let library = InspectorSections.library(artifacts: artifacts)
    #expect(library.map(\.title) == ["资料库"])
    #expect(!library[0].isEmpty)
    #expect(library[0].placeholder.title == "资料库还是空的")

    let emptyLibrary = InspectorSections.library(artifacts: [])
    #expect(emptyLibrary[0].isEmpty)
    #expect(emptyLibrary[0].placeholder.title == "资料库还是空的")

    let computer = InspectorSections.computer()
    #expect(computer.map(\.title) == ["电脑"])
    #expect(computer.allSatisfy { $0.isEmpty })
  }

  @Test("a section with rows never reads as empty, whatever the row kind")
  func emptinessFollowsRows() {
    let sections = InspectorSections.detail(artifacts: [], jobs: jobs, tasks: [], usage: [])
    #expect(sections.map(\.isEmpty) == [true, true, false, true, true])
    let onlyArtifacts = InspectorSections.detail(
      artifacts: artifacts, jobs: [], tasks: [], usage: [])
    #expect(onlyArtifacts.map(\.isEmpty) == [true, false, true, true, true])
    let withUsage = InspectorSections.detail(
      artifacts: [], jobs: [], tasks: [],
      usage: [InspectorUsageRow(id: "input", label: "输入", value: "812")])
    #expect(withUsage.map(\.isEmpty) == [true, true, true, true, false])
  }

  @Test("a task row indents with its depth and spins only while running")
  func taskRowFields() {
    #expect(tasks[0].depth == 0 && tasks[1].depth == 1)
    #expect(tasks[0].isRunning)
    #expect(!tasks[1].isRunning)
    #expect(Theme.Metric.panelTaskIndent > 0)
    #expect(Theme.Metric.panelTaskRowHeight < Theme.Metric.inspectorRowHeight)
  }
}

/// A task row offers exactly one action: a parked task can be started again, everything
/// else live can be stopped — and the stop is a hover affordance, never a permanent one.
@Suite("Inspector task actions")
struct InspectorTaskActionTests {
  private func row(blocked: Bool) -> InspectorTaskRow {
    InspectorTaskRow(
      id: "t_12", title: "生成回答", symbolName: "sparkles",
      status: blocked ? "已停放" : "运行中", depth: 0, isRunning: !blocked, isBlocked: blocked)
  }

  @Test("a parked row offers retry and nothing else")
  func parked() {
    #expect(row(blocked: true).showsRetry)
    #expect(row(blocked: true).showsStop == false)
  }

  @Test("a live row offers stop")
  func live() {
    #expect(row(blocked: false).showsStop)
    #expect(row(blocked: false).showsRetry == false)
  }
}
