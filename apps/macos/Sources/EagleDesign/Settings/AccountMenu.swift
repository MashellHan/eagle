import SwiftUI

/// One row inside the account popover.
public struct AccountMenuRow: Identifiable, Hashable, Sendable {
  public enum Kind: Hashable, Sendable {
    case plan
    case plain
  }

  public let id: String
  public let systemName: String
  public let title: String
  public let detail: String?
  public let showsChevron: Bool
  public let kind: Kind
  public let destructive: Bool
  public let separatorBefore: Bool

  public init(
    id: String,
    systemName: String,
    title: String,
    detail: String? = nil,
    showsChevron: Bool = false,
    kind: Kind = .plain,
    destructive: Bool = false,
    separatorBefore: Bool = false
  ) {
    self.id = id
    self.systemName = systemName
    self.title = title
    self.detail = detail
    self.showsChevron = showsChevron
    self.kind = kind
    self.destructive = destructive
    self.separatorBefore = separatorBefore
  }
}

/// Popover anchored on the sidebar user row: plan usage, settings, sign-out.
public struct AccountMenu: View {
  private let rows: [AccountMenuRow]
  private let onSelect: (AccountMenuRow) -> Void
  @State private var hovering: String?

  public init(rows: [AccountMenuRow], onSelect: @escaping (AccountMenuRow) -> Void) {
    self.rows = rows
    self.onSelect = onSelect
  }

  public var body: some View {
    VStack(spacing: 0) {
      ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
        if index > 0, row.separatorBefore {
          Rectangle()
            .fill(Theme.Palette.line)
            .frame(height: Theme.Metric.hairline)
            .padding(.vertical, 6)
            .padding(.horizontal, 14)
        }
        Button {
          onSelect(row)
        } label: {
          HStack(spacing: 12) {
            Image(systemName: row.systemName)
              .font(.system(size: 15))
              .foregroundStyle(
                row.destructive ? Theme.Palette.destructive : Theme.Palette.textPrimary
              )
              .frame(width: 20)
            Text(row.title)
              .font(.system(size: 14, weight: row.kind == .plan ? .semibold : .regular))
              .foregroundStyle(
                row.destructive ? Theme.Palette.destructive : Theme.Palette.textPrimary)
            Spacer(minLength: 8)
            if let detail = row.detail {
              Text(detail)
                .font(Theme.TypeScale.note)
                .foregroundStyle(Theme.Palette.textSecondary)
            }
            if row.showsChevron {
              Image(systemName: "chevron.right")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(Theme.Palette.textMuted)
            }
          }
          .padding(.horizontal, 14)
          .frame(height: Theme.Metric.accountRowHeight)
          .background(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
              .fill(hovering == row.id ? Theme.Palette.hover : .clear)
              .padding(.horizontal, 6)
          )
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 ? row.id : (hovering == row.id ? nil : hovering) }
      }
    }
    .animation(.easeOut(duration: 0.1), value: hovering)
    .padding(.vertical, 8)
    .frame(width: Theme.Metric.accountMenuWidth)
    .background(
      RoundedRectangle(cornerRadius: Theme.Metric.settingsCardRadius, style: .continuous)
        .fill(Theme.Palette.card)
    )
    .overlay(
      RoundedRectangle(cornerRadius: Theme.Metric.settingsCardRadius, style: .continuous)
        .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
    )
    .shadow(color: .black.opacity(0.10), radius: 18, y: 6)
  }
}
