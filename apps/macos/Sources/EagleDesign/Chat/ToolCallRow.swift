import SwiftUI

/// One tool invocation in the transcript: the call and, once it lands, its result. It is
/// a compact card that stays out of the answer's way, expands on click, and colors only
/// the failure state (docs/bots/PRODUCT.md, "Delegation").
public struct ToolRow: Hashable, Sendable {
  public var name: String
  /// The one-line argument hint, for example `path=notes.txt`.
  public var subtitle: String
  /// Pretty-printed arguments; empty when the call carried none.
  public var input: String
  /// The result text, once the daemon appends the tool row.
  public var output: String?
  public var isError: Bool
  public var isRunning: Bool
  /// A short human duration, for example `21 ms`.
  public var duration: String?

  public init(
    name: String,
    subtitle: String,
    input: String = "",
    output: String? = nil,
    isError: Bool = false,
    isRunning: Bool = false,
    duration: String? = nil
  ) {
    self.name = name
    self.subtitle = subtitle
    self.input = input
    self.output = output
    self.isError = isError
    self.isRunning = isRunning
    self.duration = duration
  }
}

/// The tool row itself. Dense by default: one line, no vertical air, so a long tool run
/// reads as a list; the body opens only when asked for.
public struct ToolCallRow: View {
  private let row: ToolRow
  @State private var expanded = false

  public init(_ row: ToolRow) {
    self.row = row
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
      if expanded {
        body(of: row)
          .padding(.horizontal, 10)
          .padding(.bottom, 9)
      } else if let preview = preview {
        // The result is visible without a click: one dim line, the rest on expansion.
        Text(preview)
          .font(.system(size: 11.5, design: .monospaced))
          .foregroundStyle(
            row.isError ? Theme.Palette.destructive : Theme.Palette.textMuted
          )
          .lineLimit(1)
          .truncationMode(.tail)
          .padding(.horizontal, 10)
          .padding(.bottom, 7)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .background(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(Theme.Palette.card)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .strokeBorder(
          row.isError ? Theme.Palette.destructive.opacity(0.5) : Theme.Palette.line,
          lineWidth: Theme.Metric.hairline
        )
    )
    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    .contentShape(Rectangle())
    .onTapGesture { withAnimation(.easeOut(duration: 0.16)) { expanded.toggle() } }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("工具 \(row.name)")
  }

  private var preview: String? {
    guard let output = row.output else { return nil }
    let line = output.split(separator: "\n", omittingEmptySubsequences: true).first.map(String.init)
    guard let line, !line.isEmpty else { return nil }
    return line
  }

  private var header: some View {
    HStack(spacing: 7) {
      Image(systemName: "wrench.and.screwdriver")
        .font(.system(size: 10.5, weight: .medium))
        .foregroundStyle(
          row.isError ? Theme.Palette.destructive : Theme.Palette.textSecondary
        )
        .frame(width: 14)
      Text(row.name)
        .font(.system(size: 12, weight: .semibold, design: .monospaced))
        .foregroundStyle(Theme.Palette.textPrimary)
        .lineLimit(1)
      if !row.subtitle.isEmpty {
        Text(row.subtitle)
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.textMuted)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      Spacer(minLength: 6)
      if row.isRunning {
        SpinnerArc(size: 11, lineWidth: 1.5)
      } else if row.isError {
        Text("失败")
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.destructive)
      } else if let duration = row.duration {
        Text(duration)
          .font(.system(size: 11.5, design: .monospaced))
          .foregroundStyle(Theme.Palette.textMuted)
      }
      Image(systemName: expanded ? "chevron.up" : "chevron.down")
        .font(.system(size: 9, weight: .semibold))
        .foregroundStyle(Theme.Palette.textMuted)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 7)
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  @ViewBuilder
  private func body(of row: ToolRow) -> some View {
    VStack(alignment: .leading, spacing: 7) {
      if !row.input.isEmpty {
        label("参数")
        ScrollView(.vertical) {
          Text(row.input)
            .font(.system(size: 11.5, design: .monospaced))
            .foregroundStyle(Theme.Palette.textSecondary)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 160)
      }
      if let output = row.output, !output.isEmpty {
        label(row.isError ? "错误" : "结果")
        ScrollView(.vertical) {
          Text(output)
            .font(.system(size: 11.5, design: .monospaced))
            .foregroundStyle(
              row.isError ? Theme.Palette.destructive : Theme.Palette.textSecondary
            )
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 220)
      }
    }
  }

  private func label(_ text: String) -> some View {
    Text(text)
      .font(.system(size: 10.5, weight: .medium))
      .foregroundStyle(Theme.Palette.textMuted)
  }
}
