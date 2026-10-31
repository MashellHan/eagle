import Testing

@testable import EagleDesign

@Suite("Inspector section assembly")
struct InspectorSectionTests {
  private let pulls = [
    InspectorPullRow(
      id: "p1", title: "deps: 依赖升级到 2.4.0", host: "github.com", status: "merged",
      url: "https://github.com/nocoo/eagle/pull/490"),
    InspectorPullRow(
      id: "p2", title: "fix: reconnect after sleep", host: "dev.azure.com", status: "reviewing",
      url: "https://dev.azure.com/hexly/eagle/_git/eagle/pullrequest/12"),
  ]
  private let tasks = [
    InspectorTaskRow(
      id: "t_12", title: "生成回答", symbolName: "sparkles", status: "运行中", depth: 0,
      isRunning: true, isBlocked: false),
    InspectorTaskRow(
      id: "t_13", title: "工具调用", symbolName: "wrench.and.screwdriver", status: "等待",
      depth: 1, isRunning: false, isBlocked: false),
  ]

  @Test("详情 is 编码 and 任务: what the open conversation is doing now")
  func detailOrder() {
    let sections = InspectorSections.detail(pulls: pulls, tasks: tasks)
    #expect(sections.map(\.title) == ["编码", "任务"])
    #expect(sections.map(\.id).count == Set(sections.map(\.id)).count)
    #expect(sections.allSatisfy { !$0.symbolName.isEmpty }, "every section header carries a glyph")
    guard case .pulls(let pullRows) = sections[0].rows else {
      Issue.record("the first section holds the reported pull requests")
      return
    }
    #expect(pullRows == pulls)
    guard case .tasks(let taskRows) = sections[1].rows else {
      Issue.record("the second section holds the tasks")
      return
    }
    #expect(taskRows == tasks)
  }

  @Test("模型 holds the agent choices and what they have spent")
  func modelTab() {
    let usage = [
      InspectorUsageRow(id: "input", label: "输入", value: "12.3k"),
      InspectorUsageRow(id: "cost", label: "花费", value: "$0.42"),
    ]
    let choices = [
      InspectorChoiceRow(
        id: "model", label: "模型", value: "auto/gpt-6-luna", selected: "auto/gpt-6-luna",
        choices: [.init(id: "auto/gpt-6-luna", title: "auto/gpt-6-luna")])
    ]
    let sections = InspectorSections.model(choices: choices, usage: usage)
    #expect(sections.map(\.title) == ["模型", "用量"])
    guard case .choices(let rows) = sections[0].rows else {
      Issue.record("the first section holds the agent choices")
      return
    }
    #expect(rows == choices)
    guard case .usage(let figures) = sections[1].rows else {
      Issue.record("the second section holds the usage")
      return
    }
    #expect(figures == usage)
  }

  @Test("an empty section keeps its header and carries an icon, a line and a sentence")
  func emptySections() {
    let sections = InspectorSections.detail(pulls: [], tasks: [])
    #expect(sections.map(\.title) == ["编码", "任务"], "a section never disappears")
    #expect(sections.allSatisfy { $0.isEmpty })
    #expect(sections.map(\.placeholder.title) == ["还没有 Pull Request", "没有正在运行的任务"])
    #expect(sections.allSatisfy { !$0.placeholder.symbolName.isEmpty })
    #expect(sections.allSatisfy { !$0.placeholder.detail.isEmpty })
    #expect(sections[1].placeholder.title == "没有正在运行的任务")
  }

  @Test("every pull-request state has its own glyph, colour and word")
  func pullAppearance() {
    let states = ["draft", "open", "reviewing", "merged", "closed", "failed"]
    let appearances = states.map { status in
      InspectorPullRow(id: status, title: "t", host: "github.com", status: status, url: "https://x")
        .appearance
    }
    #expect(Set(appearances.map(\.symbol)).count == states.count, "one glyph per state")
    #expect(Set(appearances.map(\.label)).count == states.count, "one word per state")
    #expect(appearances[3].tint == Theme.Palette.accentStrong, "merged reads as done")
    #expect(appearances[5].tint == Theme.Palette.destructive, "failed reads as a problem")
    #expect(appearances[0].tint == Theme.Palette.textMuted, "draft is not a result yet")

    let unknown = InspectorPullRow(
      id: "x", title: "t", host: "github.com", status: "reopened", url: "https://x")
    #expect(unknown.appearance.label == "reopened")
    #expect(unknown.appearance.tint == Theme.Palette.textMuted)
  }

  @Test("the inspector tabs read 详情, 模型, 触发器, 资料库, 电脑 in that order")
  func tabOrder() {
    #expect(InspectorColumn.Tab.allCases.map(\.rawValue) == ["详情", "模型", "触发器", "资料库", "电脑"])
  }

  @Test("the library and computer tabs are decorated sections too")
  func libraryAndComputer() {
    let library = InspectorSections.library()
    #expect(library.map(\.title) == ["资料库"])
    #expect(library[0].isEmpty)
    #expect(library[0].placeholder.title == "资料库还是空的")

    let computer = InspectorSections.computer()
    #expect(computer.map(\.title) == ["电脑"])
    #expect(computer.allSatisfy { $0.isEmpty })
  }

  @Test("a section with rows never reads as empty, whatever the row kind")
  func emptinessFollowsRows() {
    let sections = InspectorSections.detail(pulls: [], tasks: tasks)
    #expect(sections.map(\.isEmpty) == [true, false])
    let onlyPulls = InspectorSections.detail(pulls: pulls, tasks: [])
    #expect(onlyPulls.map(\.isEmpty) == [false, true])
    let withUsage = InspectorSections.model(
      choices: [], usage: [InspectorUsageRow(id: "input", label: "输入", value: "812")])
    #expect(withUsage.map(\.isEmpty) == [true, false])
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
