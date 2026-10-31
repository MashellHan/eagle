import BotsCore
import Testing

@testable import EagleDesign
@testable import EagleFeatures

/// The inspector's 任务 section: the daemon's task graph in, rows and Chinese labels out.
@Suite("Bots inspector tasks")
struct BotsInspectorTaskTests {
  private let presenter = BotsPresenter()

  private func task(
    _ id: String,
    kind: String = "pi.generation",
    status: TaskStatus = .running,
    blocked: String? = nil,
    owner: String? = nil
  ) -> TaskSummary {
    TaskSummary(
      id: id,
      kind: kind,
      status: status,
      phase: "generate",
      background: false,
      blocked: blocked,
      owner: owner,
      conversationId: "c_1"
    )
  }

  @Test("a kind maps to a name a person reads, and an unknown kind stays as it is")
  func titles() {
    #expect(presenter.taskTitle(for: "pi.generation") == "生成回答")
    #expect(presenter.taskTitle(for: "pi.tool") == "工具调用")
    #expect(presenter.taskTitle(for: "pi.compaction") == "上下文压缩")
    #expect(presenter.taskTitle(for: "bots.agents.child") == "子 Agent")
    #expect(presenter.taskTitle(for: "agents.research") == "agents.research")
    #expect(presenter.taskSymbol(for: "pi.generation") != presenter.taskSymbol(for: "pi.tool"))
    #expect(
      presenter.taskSymbol(for: "bots.agents.child") == presenter.taskSymbol(for: "bots.agents"))
    #expect(!presenter.taskSymbol(for: "agents.research").isEmpty)
  }

  @Test("every status the daemon sends has its own word")
  func statusLabels() {
    #expect(presenter.taskStatusLabel(.pending, blocked: nil) == "排队")
    #expect(presenter.taskStatusLabel(.running, blocked: nil) == "运行中")
    #expect(presenter.taskStatusLabel(.waiting, blocked: nil) == "等待")
    #expect(presenter.taskStatusLabel(.sleeping, blocked: nil) == "休眠")
    #expect(presenter.taskStatusLabel(.completing, blocked: nil) == "收尾")
    #expect(
      presenter.taskStatusLabel(TaskStatus(rawValue: "throttled"), blocked: nil) == "throttled",
      "a status the client does not know is shown, never invented")
  }

  @Test("a blocked task says why instead of what it is doing")
  func blockedReasons() {
    #expect(presenter.taskStatusLabel(.waiting, blocked: "restart_limit") == "已停放：重试次数过多")
    #expect(presenter.taskStatusLabel(.waiting, blocked: "missing_task") == "已停放：任务定义缺失")
    #expect(presenter.taskStatusLabel(.waiting, blocked: "task_too_old") == "已停放：任务过旧")
    #expect(presenter.taskStatusLabel(.waiting, blocked: "migration_failed") == "已停放：迁移失败")
    #expect(presenter.taskStatusLabel(.waiting, blocked: "unknown_reason") == "已停放：unknown_reason")
  }

  @Test("a child task is nested under its owner, parents before children")
  func nesting() {
    let rows = presenter.inspectorTasks(for: [
      task("t_3", kind: "pi.tool", owner: "t_2"),
      task("t_2", owner: "t_1"),
      task("t_1"),
      task("t_9", kind: "pi.tool"),
    ])
    #expect(rows.map(\.id) == ["t_1", "t_2", "t_3", "t_9"], "a parent comes before its children")
    #expect(rows.map(\.depth) == [0, 1, 2, 0])
    #expect(rows[0].title == "生成回答")
    #expect(rows[2].title == "工具调用")
  }

  @Test("deep nesting is capped so a name keeps room on one line")
  func depthCap() {
    var tasks: [TaskSummary] = [task("t_1")]
    for index in 2...6 {
      tasks.append(task("t_\(index)", kind: "pi.tool", owner: "t_\(index - 1)"))
    }
    let rows = presenter.inspectorTasks(for: tasks)
    #expect(rows.map(\.id) == tasks.map(\.id))
    #expect(rows.map(\.depth) == [0, 1, 2, 3, 3, 3])
  }

  @Test("an owner that is not in the list, or a cycle, never nests or loops")
  func orphanAndCycle() {
    let rows = presenter.inspectorTasks(for: [
      task("t_1", owner: "t_missing"),
      task("t_2", owner: "t_3"),
      task("t_3", owner: "t_2"),
    ])
    #expect(rows.map(\.id) == ["t_1", "t_2", "t_3"])
    #expect(rows.map(\.depth) == [0, 0, 0], "a cycle has no root, so it stays flat")
  }

  @Test("only a running task spins, and a blocked task says so")
  func runningAndBlocked() {
    let rows = presenter.inspectorTasks(for: [
      task("t_1", status: .running),
      task("t_2", status: .waiting),
      task("t_3", status: .sleeping, blocked: "restart_limit"),
    ])
    #expect(rows.map(\.isRunning) == [true, false, false])
    #expect(rows.map(\.isBlocked) == [false, false, true])
    #expect(rows[2].status == "已停放：重试次数过多")
    #expect(rows[1].status == "等待")
  }

  @Test("no tasks is an empty list, which the section reads as its empty state")
  func empty() {
    #expect(presenter.inspectorTasks(for: []).isEmpty)
    let sections = InspectorSections.detail(
      pulls: [], tasks: presenter.inspectorTasks(for: []))
    #expect(sections[1].isEmpty)
    #expect(sections[1].placeholder.title == "没有正在运行的任务")
  }
}

/// The inspector's 用量 section: tokens read at a glance, cost only when the provider
/// reports one, and nothing at all before the first answered turn.
@Suite("Bots inspector usage")
struct BotsInspectorUsageTests {
  private let presenter = BotsPresenter()

  @Test("no usage yet is an empty section, not a row of zeros")
  func emptyUsage() {
    #expect(presenter.inspectorUsage(for: nil).isEmpty)
  }

  @Test("tokens are abbreviated and the cost is formatted")
  func rows() {
    let usage = Usage(inputTokens: 12_345, outputTokens: 812, totalTokens: 13_157, costUsd: 0.42)
    let rows = presenter.inspectorUsage(for: usage)
    #expect(rows.map(\.id) == ["input", "output", "total", "cost"])
    #expect(rows.first { $0.id == "input" }?.value == "12.3k")
    #expect(rows.first { $0.id == "output" }?.value == "812")
    #expect(rows.first { $0.id == "cost" }?.value == "$0.42")
  }

  @Test("a provider without cost shows tokens only, and tiny costs round down")
  func costEdgeCases() {
    let usage = Usage(inputTokens: 1_200_000, outputTokens: 1, totalTokens: 1_200_001)
    let rows = presenter.inspectorUsage(for: usage)
    #expect(rows.map(\.id) == ["input", "output", "total"])
    #expect(rows.first { $0.id == "input" }?.value == "1.2M")
    let tiny = Usage(inputTokens: 10, outputTokens: 1, totalTokens: 11, costUsd: 0.004)
    #expect(presenter.inspectorUsage(for: tiny).last?.value == "<$0.01")
  }
}

/// The inspector's 模型 section: the bot's own model and level as menus, with the daemon's
/// accepted values and a Chinese label for the level.
@Suite("Bots inspector agent")
struct BotsInspectorAgentTests {
  private let presenter = BotsPresenter()

  private func bot(model: String = "auto/gpt-6-luna") -> BotSummary {
    BotSummary(
      id: "b_1",
      title: "研究员",
      createdAt: "x",
      updatedAt: "x",
      model: ModelRef(provider: "magpie", modelId: model),
      state: .idle
    )
  }

  @Test("the current model comes first when the gateway does not list it")
  func modelChoices() {
    let rows = presenter.agentChoices(for: bot(), agent: nil, models: ["auto/gpt-6-sol"])
    #expect(rows.map(\.id) == ["model", "thinking"])
    #expect(rows[0].value == "auto/gpt-6-luna")
    #expect(rows[0].choices.map(\.id) == ["auto/gpt-6-luna", "auto/gpt-6-sol"])
  }

  @Test("the level shows in Chinese and every daemon level is offered")
  func levelRow() {
    let agent = AgentView(
      model: ModelRef(provider: "magpie", modelId: "auto/gpt-6-luna"),
      thinkingLevel: "xhigh",
      instructions: ""
    )
    let rows = presenter.agentChoices(for: bot(), agent: agent, models: [])
    #expect(rows[1].value == "极高")
    #expect(rows[1].selected == "xhigh")
    #expect(rows[1].choices.map(\.id) == BotsPresenter.thinkingLevels)
  }

  @Test("a missing agent view falls back to medium")
  func fallback() {
    #expect(presenter.agentChoices(for: bot(), agent: nil, models: [])[1].selected == "medium")
  }
}
