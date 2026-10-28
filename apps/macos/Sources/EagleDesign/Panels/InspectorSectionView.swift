import SwiftUI

/// One decorated section: the shared header, then either its rows or its empty state.
public struct InspectorSectionView: View {
  private let section: InspectorSectionModel
  private let onToggleJob: (String, Bool) -> Void
  private let onExpand: () -> Void
  private let onRetryTask: (String) -> Void
  private let onStopTask: (String) -> Void
  private let onChoose: (String, String) -> Void

  public init(
    section: InspectorSectionModel,
    onToggleJob: @escaping (String, Bool) -> Void = { _, _ in },
    onExpand: @escaping () -> Void = {},
    onRetryTask: @escaping (String) -> Void = { _ in },
    onStopTask: @escaping (String) -> Void = { _ in },
    onChoose: @escaping (String, String) -> Void = { _, _ in }
  ) {
    self.section = section
    self.onToggleJob = onToggleJob
    self.onExpand = onExpand
    self.onRetryTask = onRetryTask
    self.onStopTask = onStopTask
    self.onChoose = onChoose
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: Theme.Metric.panelSectionBodyGap) {
      PanelSectionHeader(symbolName: section.symbolName, title: section.title)
      if section.isEmpty {
        PanelEmptyState(placeholder: section.placeholder)
      } else {
        rows
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  @ViewBuilder
  private var rows: some View {
    switch section.rows {
    case .artifacts(let artifacts):
      VStack(spacing: Theme.Metric.panelSectionBodyGap) {
        ForEach(artifacts) { artifact in
          ChevronRow(
            systemName: "chevron.left.forwardslash.chevron.right", title: artifact.title)
        }
        TextAction("展开", action: onExpand)
          .frame(maxWidth: .infinity)
      }
    case .jobs(let jobs):
      VStack(spacing: Theme.Metric.panelSectionBodyGap) {
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
      }
    case .choices(let rows):
      VStack(alignment: .leading, spacing: Theme.Metric.panelTaskRowGap) {
        ForEach(rows) { row in
          HStack(spacing: Theme.Metric.panelSectionRowGap) {
            Text(row.label)
              .font(Theme.TypeScale.pill)
              .foregroundStyle(Theme.Palette.textMuted)
            Spacer(minLength: 8)
            Menu {
              ForEach(row.choices) { choice in
                Button {
                  onChoose(row.id, choice.id)
                } label: {
                  if choice.id == row.selected {
                    Label(choice.title, systemImage: "checkmark")
                  } else {
                    Text(choice.title)
                  }
                }
              }
            } label: {
              HStack(spacing: 4) {
                Text(row.value)
                  .font(Theme.TypeScale.pill)
                  .foregroundStyle(Theme.Palette.textPrimary)
                  .lineLimit(1)
                Image(systemName: "chevron.down")
                  .font(.system(size: 8, weight: .semibold))
                  .foregroundStyle(Theme.Palette.textMuted)
              }
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .fixedSize()
          }
          .frame(height: Theme.Metric.panelTaskRowHeight)
        }
      }
    case .usage(let rows):
      VStack(alignment: .leading, spacing: Theme.Metric.panelTaskRowGap) {
        ForEach(rows) { row in
          HStack(spacing: Theme.Metric.panelSectionRowGap) {
            Text(row.label)
              .font(Theme.TypeScale.pill)
              .foregroundStyle(Theme.Palette.textMuted)
            Spacer(minLength: 8)
            Text(row.value)
              .font(Theme.TypeScale.mono)
              .foregroundStyle(Theme.Palette.textPrimary)
          }
        }
      }
    case .tasks(let tasks):
      VStack(alignment: .leading, spacing: Theme.Metric.panelTaskRowGap) {
        ForEach(tasks) { row in
          InspectorTaskRowView(
            row: row,
            onRetry: { onRetryTask(row.id) },
            onStop: { onStopTask(row.id) }
          )
        }
      }
      .background(alignment: .topLeading) {
        InspectorTaskTree(depths: tasks.map(\.depth))
          .stroke(
            Theme.Palette.taskGuide,
            style: StrokeStyle(
              lineWidth: Theme.Metric.hairline, lineCap: .round, lineJoin: .round,
              dash: Theme.Metric.panelTaskGuideDash)
          )
          .allowsHitTesting(false)
          .accessibilityHidden(true)
      }
    case .none:
      EmptyView()
    }
  }
}

/// One live task: its kind's glyph, its name, and what it is doing right now. A child is
/// indented under its owner; a running task carries the panel's own spinner.
struct InspectorTaskRowView: View {
  let row: InspectorTaskRow
  var onRetry: () -> Void = {}
  var onStop: () -> Void = {}
  @State private var hovering = false

  var body: some View {
    HStack(spacing: Theme.Metric.panelSectionRowGap) {
      Image(systemName: row.symbolName)
        .font(.system(size: Theme.Metric.panelSectionGlyph, weight: .medium))
        .foregroundStyle(Theme.Palette.textMuted)
        .frame(width: Theme.Metric.panelSectionGlyphWidth)
      Text(row.title)
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textPrimary)
        .lineLimit(1)
        .truncationMode(.tail)
      Spacer(minLength: 6)
      if row.isRunning {
        SpinnerArc(size: Theme.Metric.panelTaskSpinner, lineWidth: 1.4)
      }
      Text(row.status)
        .font(Theme.TypeScale.pill)
        .foregroundStyle(row.isBlocked ? Theme.Palette.destructive : Theme.Palette.textSecondary)
        .lineLimit(1)
        .truncationMode(.tail)
      // A parked row offers its action always, because nothing else can clear it; a live
      // row offers 停止 only under the pointer, like every other row affordance.
      if row.showsRetry {
        TextAction("重试", action: onRetry)
      } else if row.showsStop && hovering {
        IconButton(
          systemName: "stop.circle", label: "停止", size: Theme.Metric.messageActionGlyph + 6,
          glyphSize: Theme.Metric.messageActionGlyph, action: onStop
        )
      }
    }
    .padding(.leading, CGFloat(row.depth) * Theme.Metric.panelTaskIndent)
    .frame(height: Theme.Metric.panelTaskRowHeight)
    .contentShape(Rectangle())
    .onHover { hovering = $0 }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(row.title) \(row.status)")
  }
}
