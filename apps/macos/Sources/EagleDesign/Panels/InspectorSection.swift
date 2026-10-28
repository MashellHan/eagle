import SwiftUI

/// What a section shows instead of rows: one glyph, one short line and one sentence, so an
/// empty section still carries the panel's decoration instead of leaving a hole
/// (docs/bots/PRODUCT.md, inspector).
public struct InspectorPlaceholder: Hashable, Sendable {
  public let symbolName: String
  public let title: String
  public let detail: String

  public init(symbolName: String, title: String, detail: String) {
    self.symbolName = symbolName
    self.title = title
    self.detail = detail
  }
}

/// One live task as the inspector draws it: already named, already indented, already spelled
/// in the person's language. The mapping lives in the view model, never in the view.
public struct InspectorTaskRow: Identifiable, Hashable, Sendable {
  public let id: String
  public let title: String
  public let symbolName: String
  public let status: String
  /// 0 for a root task, one more for every owner above it.
  public let depth: Int
  public let isRunning: Bool
  public let isBlocked: Bool

  /// A parked task is the one a person can start again; everything else live can be stopped.
  public var showsRetry: Bool { isBlocked }
  public var showsStop: Bool { !isBlocked }

  public init(
    id: String,
    title: String,
    symbolName: String,
    status: String,
    depth: Int,
    isRunning: Bool,
    isBlocked: Bool
  ) {
    self.id = id
    self.title = title
    self.symbolName = symbolName
    self.status = status
    self.depth = depth
    self.isRunning = isRunning
    self.isBlocked = isBlocked
  }
}

/// One read-only figure of the 用量 section: a label and its already-formatted value.
public struct InspectorUsageRow: Identifiable, Hashable, Sendable {
  public let id: String
  public let label: String
  public let value: String

  public init(id: String, label: String, value: String) {
    self.id = id
    self.label = label
    self.value = value
  }
}

/// One row of the 模型 section: a label, the current choice, and the choices a menu offers.
public struct InspectorChoiceRow: Identifiable, Hashable, Sendable {
  public struct Choice: Identifiable, Hashable, Sendable {
    public let id: String
    public let title: String

    public init(id: String, title: String) {
      self.id = id
      self.title = title
    }
  }

  public let id: String
  public let label: String
  public let value: String
  /// The chosen id, or nil when the bot follows the daemon-wide setting.
  public let selected: String?
  public let choices: [Choice]

  public init(
    id: String,
    label: String,
    value: String,
    selected: String?,
    choices: [Choice]
  ) {
    self.id = id
    self.label = label
    self.value = value
    self.selected = selected
    self.choices = choices
  }
}

/// One decorated section of the inspector: its header and either rows or a placeholder.
public struct InspectorSectionModel: Identifiable, Hashable, Sendable {
  public enum Rows: Hashable, Sendable {
    case artifacts([InspectorArtifact])
    case jobs([InspectorJob])
    case tasks([InspectorTaskRow])
    case usage([InspectorUsageRow])
    case choices([InspectorChoiceRow])
    /// A section whose whole body is its placeholder.
    case none
  }

  public let id: String
  public let title: String
  public let symbolName: String
  public let rows: Rows
  public let placeholder: InspectorPlaceholder

  public init(
    id: String,
    title: String,
    symbolName: String,
    rows: Rows,
    placeholder: InspectorPlaceholder
  ) {
    self.id = id
    self.title = title
    self.symbolName = symbolName
    self.rows = rows
    self.placeholder = placeholder
  }

  public var isEmpty: Bool {
    switch rows {
    case .artifacts(let rows): return rows.isEmpty
    case .jobs(let rows): return rows.isEmpty
    case .tasks(let rows): return rows.isEmpty
    case .usage(let rows): return rows.isEmpty
    case .choices(let rows): return rows.isEmpty
    case .none: return true
    }
  }
}

/// The inspector's sections as data: which ones exist, in which order, and what they say when
/// they hold nothing. Pure, so the decoration is decided without a running view.
public enum InspectorSections {
  public static let artifactsSection = InspectorSectionModel(
    id: "artifacts",
    title: "编码",
    symbolName: "chevron.left.forwardslash.chevron.right",
    rows: .artifacts([]),
    placeholder: InspectorPlaceholder(
      symbolName: "shippingbox",
      title: "还没有产物",
      detail: "这个 Bot 生成的文件会出现在这里。"
    )
  )

  public static let jobsSection = InspectorSectionModel(
    id: "jobs",
    title: "例行任务",
    symbolName: "clock",
    rows: .jobs([]),
    placeholder: InspectorPlaceholder(
      symbolName: "clock.arrow.circlepath",
      title: "没有例行任务",
      detail: "按计划自动运行的调度会出现在这里。"
    )
  )

  public static let tasksSection = InspectorSectionModel(
    id: "tasks",
    title: "任务",
    symbolName: "bolt",
    rows: .tasks([]),
    placeholder: InspectorPlaceholder(
      symbolName: "checkmark.circle",
      title: "没有正在运行的任务",
      detail: "发出消息后，正在跑的步骤会实时出现在这里。"
    )
  )

  public static let modelSection = InspectorSectionModel(
    id: "model",
    title: "模型",
    symbolName: "cpu",
    rows: .choices([]),
    placeholder: InspectorPlaceholder(
      symbolName: "cpu",
      title: "这个会话没有模型",
      detail: "选中一个 Bot 后，它的模型与思考等级会出现在这里。"
    )
  )

  public static let usageSection = InspectorSectionModel(
    id: "usage",
    title: "用量",
    symbolName: "chart.bar",
    rows: .usage([]),
    placeholder: InspectorPlaceholder(
      symbolName: "chart.bar",
      title: "还没有用量",
      detail: "发出消息后，token 与花费会累加在这里。"
    )
  )

  public static let librarySection = InspectorSectionModel(
    id: "library",
    title: "资料库",
    symbolName: "books.vertical",
    rows: .artifacts([]),
    placeholder: InspectorPlaceholder(
      symbolName: "books.vertical",
      title: "资料库还是空的",
      detail: "接入 Herdr 后，Space 的证据与产物会出现在这里。"
    )
  )

  public static let computerSection = InspectorSectionModel(
    id: "computer",
    title: "电脑",
    symbolName: "desktopcomputer",
    rows: .none,
    placeholder: InspectorPlaceholder(
      symbolName: "desktopcomputer",
      title: "还没接入电脑",
      detail: "终端与会话信息在接入后展示。"
    )
  )

  /// 编码, 例行任务, 任务 — the detail tab always shows all three, so a section never folds
  /// away and shifts the ones below it.
  public static func detail(
    artifacts: [InspectorArtifact],
    jobs: [InspectorJob],
    tasks: [InspectorTaskRow],
    usage: [InspectorUsageRow],
    choices: [InspectorChoiceRow] = []
  ) -> [InspectorSectionModel] {
    [
      modelSection.with(.choices(choices)),
      artifactsSection.with(.artifacts(artifacts)),
      jobsSection.with(.jobs(jobs)),
      tasksSection.with(.tasks(tasks)),
      usageSection.with(.usage(usage)),
    ]
  }

  public static func library(artifacts: [InspectorArtifact]) -> [InspectorSectionModel] {
    [librarySection.with(.artifacts(artifacts))]
  }

  public static func computer() -> [InspectorSectionModel] {
    [computerSection]
  }
}

extension InspectorSectionModel {
  func with(_ rows: Rows) -> InspectorSectionModel {
    InspectorSectionModel(
      id: id,
      title: title,
      symbolName: symbolName,
      rows: rows,
      placeholder: placeholder
    )
  }
}
