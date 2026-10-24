import EagleDesign
import Foundation
import Combine

/// Static demo content so the shell and the template library can be judged
/// before any real Herdr data is wired in.
public enum MockWorkspace {
  public static let groups: [SidebarGroup] = [
    SidebarGroup(id: "secretariat", title: "秘书处", items: [
      SidebarItem(
        id: "investigator", title: "首席调查官",
        subtitle: "哥，最值得借鉴的是 OpenClaw 的聊天界面模块...", tintIndex: 0),
      SidebarItem(
        id: "secretary", title: "工作秘书",
        subtitle: "哥，周末早上有两件事：", tag: "Personal", tintIndex: 1),
      SidebarItem(
        id: "xbutler", title: "X管家",
        subtitle: "Brotli 那条已经转给 @安全审查师了，原帖和 C...", tag: "Personal", tintIndex: 2),
      SidebarItem(
        id: "mail", title: "个人邮件管家",
        subtitle: "收件箱摘要 2026-10-24 06:00（北京时间）", tag: "Personal", tintIndex: 3),
      SidebarItem(
        id: "life", title: "生活秘书",
        subtitle: "读到了，你现在在北京大兴区旧宫镇，坐标大约...", tag: "Personal", tintIndex: 4),
    ]),
    SidebarGroup(id: "news", title: "新闻组", count: 9, items: [
      SidebarItem(
        id: "knowledge", title: "知识库",
        subtitle: "哥，我查过了：翻墙大师的知识库 key 现在只能...", tag: "Personal", tintIndex: 5),
      SidebarItem(
        id: "fund", title: "基金经理",
        subtitle: "好，那次同步就让它在 Studio 上跑完，我不催...", tag: "Personal", tintIndex: 3),
    ]),
    SidebarGroup(id: "review", title: "审查组", count: 4, items: [
      SidebarItem(
        id: "deps", title: "依赖修复专家",
        subtitle: "第一批 8 个仓库已经开始修了，每小时给你发一次进度",
        tag: "GitHub", tintIndex: 2),
    ]),
  ]

  public static let transcript: [TranscriptEntry] = [
    .assistant(
      id: "a1",
      blocks: [
        .bullets([
          "firefly: 5 / 2, 有 CVE",
          "octo: 5 / 2, 有 CVE",
          "zhe: 11 / 2, 有 CVE，而且可修的超过 10 个",
          "bogo: 7 / 1, 有 CVE",
          "hexly.ai: 10 / 1, 有 CVE",
        ]),
        .paragraph(
          "执行计划：每个仓库开一个 PR，最多同时修 8 个。第一批是 base-mcp、firefly、octo、zhe、bogo、hexly.ai、his.fm 和 meowth，next-ai、sleepy、giraffe 和 matrix 排在后面。每个 PR 等 CI 通过后用 Codex 审查，最多 10 轮，审查通过后用 merge 方式合并。"
        ),
      ]
    ),
    .note(id: "n1", text: "已发送给 8 个智能体", tintIndices: [1, 2, 3]),
    .assistant(
      id: "a2",
      blocks: [
        .paragraph(
          "第一批 8 个仓库已经开始修了：base-mcp、firefly、octo、zhe、bogo、hexly.ai、his.fm 和 meowth。今天 10:00 到 20:00 北京时间，每小时给你发一次进度，第一次大约在 9:45 到 10:15 之间。哪个仓库合并了，我会马上告诉你。"
        )
      ]
    ),
    .note(id: "n2", text: "2 条消息往来：", tintIndices: [5, 2]),
    .assistant(
      id: "a3",
      blocks: [
        .paragraph(
          "2026-10-24 09:00 北京时间，base-mcp 合并了：PR #73，merge commit fd621be，关掉 3 个 issue（#70 #71 #72）。其中 2 个是 CVE，body-parser 升到了 2.4.0，fast-uri 升到了 3.1.9。Codex 审查 1 轮就通过了。排队的 next-ai 已经接着开始修。"
        )
      ]
    ),
    .note(id: "n3", text: "已发送给 deps 2026-10-24 next-ai 和 deps 2026-10-24 bogo", tintIndices: [2, 3]),
    .user(id: "u1", text: "今天 eagle 会修吗"),
    .typing(id: "typing"),
  ]

  public static let artifacts: [InspectorArtifact] = [
    InspectorArtifact(id: "d1", title: "deps 2026-10-24 sleepy"),
    InspectorArtifact(id: "d2", title: "deps 2026-10-24 next-ai"),
    InspectorArtifact(id: "d3", title: "deps 2026-10-24 meowth"),
    InspectorArtifact(id: "d4", title: "deps 2026-10-24 his.fm"),
    InspectorArtifact(id: "d5", title: "deps 2026-10-24 hexly.ai"),
  ]

  public static let jobs: [InspectorJob] = [
    InspectorJob(
      id: "j1", title: "每日依赖修复调度", detail: "每天 8:47", isOn: true),
    InspectorJob(
      id: "j2", title: "依赖修复进度 10-24", detail: "每小时 · 10:00–20:00", isOn: true),
  ]
}

/// Left column state. Later this list is built from `/api/v1/overview`, one
/// Herdr Space per conversation.
public final class WorkspaceListViewModel: ObservableObject {
  @Published public var groups: [SidebarGroup]
  @Published public var selection: String?

  public init(groups: [SidebarGroup] = MockWorkspace.groups, selection: String? = "deps") {
    self.groups = groups
    self.selection = selection
  }

  public func select(_ id: String) {
    selection = id
  }

  public var selectedItem: SidebarItem? {
    groups.flatMap(\.items).first { $0.id == selection }
  }
}

/// Middle column state. `send()` only appends locally until the daemon is wired.
public final class ChatViewModel: ObservableObject {
  @Published public var entries: [TranscriptEntry]
  @Published public var draft: String = ""
  @Published public private(set) var sentCount = 0

  public init(entries: [TranscriptEntry] = MockWorkspace.transcript) {
    self.entries = entries
  }

  public func send() {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    entries.append(.user(id: "local-\(sentCount)", text: text))
    entries.append(.typing(id: "typing-\(sentCount)"))
    sentCount += 1
    draft = ""
  }
}

/// Right column state.
public final class InspectorViewModel: ObservableObject {
  @Published public var artifacts: [InspectorArtifact]
  @Published public var jobs: [InspectorJob]
  @Published public var tab: InspectorColumn.Tab = .detail

  public init(
    artifacts: [InspectorArtifact] = MockWorkspace.artifacts,
    jobs: [InspectorJob] = MockWorkspace.jobs
  ) {
    self.artifacts = artifacts
    self.jobs = jobs
  }

  public func setJob(_ id: String, isOn: Bool) {
    guard let index = jobs.firstIndex(where: { $0.id == id }) else { return }
    let job = jobs[index]
    jobs[index] = InspectorJob(id: job.id, title: job.title, detail: job.detail, isOn: isOn)
  }
}
