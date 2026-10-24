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
      SidebarItem(
        id: "skills", title: "技能优化大师",
        subtitle: "哥，安全审查师的 security-incident-daily 第四...", tintIndex: 5),
      SidebarItem(
        id: "knowledge", title: "知识库",
        subtitle: "哥，我查过了：翻墙大师的知识库 key 现在只能...", tag: "Personal", tintIndex: 5),
      SidebarItem(
        id: "fund", title: "基金经理",
        subtitle: "好，那次同步就让它在 Studio 上跑完，我不催...", tag: "Personal", tintIndex: 3),
      SidebarItem(
        id: "blog", title: "博客秘书",
        subtitle: "文章已经在站上发布了：这次 reorg 没写到的那...", tag: "Personal", tintIndex: 0),
      SidebarItem(
        id: "finance", title: "财务助手",
        subtitle: "规则已写进知识库；脚本也是按「远期」标识...", tag: "Personal", tintIndex: 4),
    ]),
    SidebarGroup(id: "news", title: "新闻组", count: 9, items: [
      SidebarItem(
        id: "translator", title: "首席翻译官",
        subtitle: "已经发给 @博客秘书 了，附上了终稿路径、Xra...", tag: "News", tintIndex: 3),
      SidebarItem(
        id: "reporter", title: "行业记者",
        subtitle: "今天值得读的三条：Cursor 的 sandbox 设计、...", tag: "News", tintIndex: 1),
      SidebarItem(
        id: "digest", title: "早报编辑",
        subtitle: "早报已排好版，头图用的是昨天那张航拍。", tag: "News", tintIndex: 6),
      SidebarItem(
        id: "research", title: "调研助手",
        subtitle: "查到 4 家同类产品的定价，最低的是按席位计费。", tag: "News", tintIndex: 7),
    ]),
    SidebarGroup(id: "review", title: "审查组", count: 4, items: [
      SidebarItem(
        id: "deps", title: "依赖修复专家",
        subtitle: "第一批 8 个仓库已经开始修了，每小时给你发一次进度",
        tag: "GitHub", tintIndex: 2),
      SidebarItem(
        id: "security", title: "安全审查师",
        subtitle: "CVE-2026-3185 已确认影响 body-parser 2.3.x。", tag: "Security", tintIndex: 0),
      SidebarItem(
        id: "codex", title: "Codex 审查",
        subtitle: "PR #854 第 1 轮通过，没有需要追加的修改。", tag: "GitHub", tintIndex: 1),
    ]),
    SidebarGroup(id: "ops", title: "运维组", items: [
      SidebarItem(
        id: "build", title: "构建守护",
        subtitle: "main 分支 3 次构建失败，都是同一个快照测试。", tintIndex: 6),
      SidebarItem(
        id: "infra", title: "基础设施",
        subtitle: "东京区域的 D1 读延迟回落到 2.1ms。", tintIndex: 7),
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
          "his.fm: 1 / 1, 有 CVE",
          "meowth: 1 / 1, 有 CVE",
          "next-ai: 5 / 1, 有 CVE",
          "sleepy: 2 / 1, 有 CVE",
          "giraffe: 7 / 0, 距上次修复已经 8 天",
        ]),
        .paragraph(
          "执行计划：每个仓库开一个 PR，最多同时修 8 个。第一批是 base-mcp、firefly、octo、zhe、bogo、hexly.ai、his.fm 和 meowth，next-ai、sleepy、giraffe 和 matrix 排在后面，前面合并一个就补上一个。每个 PR 等 CI 通过后用 Codex 审查，最多 10 轮，审查通过后用 merge 方式合并。"
        ),
      ],
      sender: TranscriptSender(name: "依赖修复专家", tintIndex: 2)
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
    .note(id: "n3", text: "2 条消息往来：", tintIndices: [4, 3]),
    .assistant(
      id: "a4",
      blocks: [
        .paragraph(
          "2026-10-24 09:05 北京时间，firefly 合并了：PR #854，merge commit ac06e59，关掉 5 个 issue（#849–#853）。其中 2 个是 CVE，body-parser 升到了 2.4.0，fast-uri 升到了 4.2.3。Codex 审查 1 轮通过。sleepy 已经接着开始修。"
        )
      ]
    ),
    .note(id: "n4", text: "已发送给 deps 2026-10-24 next-ai 和 deps 2026-10-24 bogo", tintIndices: [2, 3]),
    .user(id: "u1", text: "今天 eagle 会修吗"),
    .assistant(
      id: "a5",
      blocks: [
        .paragraph(
          "eagle 不在这一批名单里：它的 6 个依赖都在上个月升过了，剩下的 1 个是 @nocoo/basalt 的次版本，等 3.3 发布再一起升。如果你现在就要，我把它插到队首。"
        )
      ]
    ),
    .typing(id: "typing"),
  ]

  public static let artifacts: [InspectorArtifact] = [
    InspectorArtifact(id: "d1", title: "deps 2026-10-24 sleepy"),
    InspectorArtifact(id: "d2", title: "deps 2026-10-24 next-ai"),
    InspectorArtifact(id: "d3", title: "deps 2026-10-24 meowth"),
    InspectorArtifact(id: "d4", title: "deps 2026-10-24 his.fm"),
    InspectorArtifact(id: "d5", title: "deps 2026-10-24 hexly.ai"),
    InspectorArtifact(id: "d6", title: "deps 2026-10-24 octo"),
    InspectorArtifact(id: "d7", title: "deps 2026-10-24 base-mcp"),
  ]

  public static let jobs: [InspectorJob] = [
    InspectorJob(
      id: "j1", title: "每日依赖修复调度", detail: "每天 8:47", isOn: true),
    InspectorJob(
      id: "j2", title: "依赖修复进度 10-24", detail: "每小时 · 10:00–20:00", isOn: true),
    InspectorJob(
      id: "j3", title: "Codex 审查轮次上限", detail: "最多 10 轮，通过即合并", isOn: true),
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

  public var totalConversations: Int {
    groups.reduce(0) { $0 + $1.items.count }
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
