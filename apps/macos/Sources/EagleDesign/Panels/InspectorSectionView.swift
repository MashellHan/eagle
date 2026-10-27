import SwiftUI

/// One decorated section: the shared header, then either its rows or its empty state.
public struct InspectorSectionView: View {
  private let section: InspectorSectionModel
  private let onToggleJob: (String, Bool) -> Void
  private let onExpand: () -> Void

  public init(
    section: InspectorSectionModel,
    onToggleJob: @escaping (String, Bool) -> Void = { _, _ in },
    onExpand: @escaping () -> Void = {}
  ) {
    self.section = section
    self.onToggleJob = onToggleJob
    self.onExpand = onExpand
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
    case .tasks(let tasks):
      VStack(alignment: .leading, spacing: Theme.Metric.panelTaskRowGap) {
        ForEach(tasks) { row in
          InspectorTaskRowView(row: row)
        }
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
    }
    .padding(.leading, CGFloat(row.depth) * Theme.Metric.panelTaskIndent)
    .frame(height: Theme.Metric.panelTaskRowHeight)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(row.title) \(row.status)")
  }
}
