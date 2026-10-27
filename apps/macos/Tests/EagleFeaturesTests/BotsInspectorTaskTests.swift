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
      artifacts: [], jobs: [], tasks: presenter.inspectorTasks(for: []))
    #expect(sections[2].isEmpty)
    #expect(sections[2].placeholder.title == "没有正在运行的任务")
  }
}
