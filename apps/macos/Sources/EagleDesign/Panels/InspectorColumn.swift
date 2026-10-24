import SwiftUI

public struct InspectorArtifact: Identifiable, Hashable, Sendable {
  public let id: String
  public let title: String

  public init(id: String, title: String) {
    self.id = id
    self.title = title
  }
}

public struct InspectorJob: Identifiable, Hashable, Sendable {
  public let id: String
  public let title: String
  public let detail: String
  public let isOn: Bool

  public init(id: String, title: String, detail: String, isOn: Bool) {
    self.id = id
    self.title = title
    self.detail = detail
    self.isOn = isOn
  }
}

/// Right column: participant summary, text tabs, artifact rows and job switches.
public struct InspectorColumn: View {
  public enum Tab: String, CaseIterable, Hashable, Sendable {
    case detail = "详情"
    case library = "资料库"
    case computer = "电脑"
  }

  private let name: String
  private let subtitle: String
  private let tintIndex: Int
  private let width: CGFloat
  private let artifacts: [InspectorArtifact]
  private let jobs: [InspectorJob]
  @Binding private var tab: Tab
  private let onToggleJob: (String, Bool) -> Void
  private let onExpand: () -> Void
  private let onCollapse: () -> Void
  private let onShare: () -> Void

  public init(
    name: String,
    subtitle: String,
    tintIndex: Int,
    width: CGFloat = Theme.Metric.inspectorWidth,
    artifacts: [InspectorArtifact],
    jobs: [InspectorJob],
    tab: Binding<Tab>,
    onToggleJob: @escaping (String, Bool) -> Void = { _, _ in },
    onExpand: @escaping () -> Void = {},
    onCollapse: @escaping () -> Void = {},
    onShare: @escaping () -> Void = {}
  ) {
    self.name = name
    self.subtitle = subtitle
    self.tintIndex = tintIndex
    self.width = width
    self.artifacts = artifacts
    self.jobs = jobs
    self._tab = tab
    self.onToggleJob = onToggleJob
    self.onExpand = onExpand
    self.onCollapse = onCollapse
    self.onShare = onShare
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HeaderRow {
        HStack(spacing: 6) {
          Spacer(minLength: 0)
          IconButton(
            systemName: "square.and.arrow.up", label: "分享", style: .circled, action: onShare)
          IconButton(
            systemName: "xmark",
            label: "收起检查器",
            size: Theme.Metric.headerControlHeight,
            style: .circled,
            action: onCollapse
          )
        }
        .padding(.trailing, Theme.Metric.panelInset)
      }

      Identity(name: name, subtitle: subtitle, tintIndex: tintIndex)

      SegmentedTabs(values: Tab.allCases, selection: $tab) { $0.rawValue }
        .padding(.horizontal, Theme.Metric.panelInset)

      ScrollView {
        VStack(alignment: .leading, spacing: 10) {
          content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(.easeOut(duration: 0.18), value: tab)
        .padding(.horizontal, Theme.Metric.panelInset)
        .padding(.top, 16)
        .padding(.bottom, 20)
      }
      .scrollEdgeFades(
        Theme.Palette.surface, top: Theme.Metric.edgeFadeHeight, bottom: Theme.Metric.edgeFadeHeight
      )
    }
    .frame(width: width)
    .frame(maxHeight: .infinity)
    .background(Theme.Palette.surface)
  }

  @ViewBuilder
  private var content: some View {
    switch tab {
    case .detail:
      SectionLabel("编码")
      ForEach(artifacts) { artifact in
        ChevronRow(
          systemName: "chevron.left.forwardslash.chevron.right",
          title: artifact.title
        )
      }
      TextAction("展开", action: onExpand)
        .frame(maxWidth: .infinity)
        .padding(.top, 2)

      SectionLabel("例行任务").padding(.top, 10)
      ForEach(jobs) { job in
        ToggleRow(
          title: job.title,
          detail: job.detail,
          isOn: Binding(
            get: { job.isOn },
            set: { onToggleJob(job.id, $0) }
          )
        )
      }
    case .library:
      SectionLabel("资料库")
      Text("尚无资料。接入 Herdr 后，Space 的证据与产物会出现在这里。")
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textSecondary)
    case .computer:
      SectionLabel("电脑")
      Text("终端与会话信息在接入后展示。")
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textSecondary)
    }
  }
}

private struct Identity: View {
  let name: String
  let subtitle: String
  let tintIndex: Int

  var body: some View {
    VStack(spacing: 8) {
      Avatar(
        initial: String(name.prefix(1)),
        tint: Theme.Palette.avatarTint(tintIndex),
        size: Theme.Metric.avatarInspector,
        shape: .blob
      )
      VStack(spacing: 3) {
        Text(name)
          .font(Theme.TypeScale.inspectorTitle)
          .foregroundStyle(Theme.Palette.textPrimary)
        Text(subtitle)
          .font(Theme.TypeScale.rowSubtitle)
          .foregroundStyle(Theme.Palette.textSecondary)
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.top, 16)
    .padding(.bottom, 18)
  }
}
