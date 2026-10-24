import SwiftUI

/// Sections of the settings window.
public enum SettingsSection: String, CaseIterable, Identifiable, Sendable {
  case general = "通用"
  case machines = "机器"
  case realtime = "实时"
  case usage = "用量与账单"
  case updates = "更新"

  public var id: String { rawValue }

  public var symbol: String {
    switch self {
    case .general: return "gearshape"
    case .machines: return "desktopcomputer"
    case .realtime: return "dot.radiowaves.left.and.right"
    case .usage: return "chart.bar"
    case .updates: return "arrow.up.circle"
    }
  }
}

/// Left rail of the settings window.
public struct SettingsRail: View {
  @Binding private var selection: SettingsSection

  public init(selection: Binding<SettingsSection>) {
    self._selection = selection
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      ForEach(SettingsSection.allCases) { section in
        Button {
          selection = section
        } label: {
          HStack(spacing: 10) {
            Image(systemName: section.symbol)
              .font(.system(size: 14))
              .foregroundStyle(Theme.Palette.textPrimary)
              .frame(width: 20)
            Text(section.rawValue)
              .font(.system(size: 14, weight: section == selection ? .medium : .regular))
              .foregroundStyle(Theme.Palette.textPrimary)
            Spacer(minLength: 0)
          }
          .padding(.horizontal, 12)
          .frame(height: 40)
          .background(
            RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
              .fill(section == selection ? Theme.Palette.line.opacity(0.7) : .clear)
          )
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 12)
    .padding(.top, 16)
    .frame(width: Theme.Metric.settingsRailWidth)
    .frame(maxHeight: .infinity, alignment: .top)
    .background(Theme.Palette.surface)
  }
}

/// Two-column settings window: rail, scrollable content, close button.
public struct SettingsScaffold<Content: View>: View {
  @Binding private var selection: SettingsSection
  private let content: Content
  private let onClose: () -> Void

  public init(
    selection: Binding<SettingsSection>,
    onClose: @escaping () -> Void = {},
    @ViewBuilder content: () -> Content
  ) {
    self._selection = selection
    self.content = content()
    self.onClose = onClose
  }

  public var body: some View {
    HStack(spacing: 0) {
      SettingsRail(selection: $selection)
      Rectangle()
        .fill(Theme.Palette.line)
        .frame(width: Theme.Metric.hairline)
      VStack(spacing: 0) {
        HStack(spacing: 16) {
          Text(selection.rawValue)
            .font(.system(size: 22, weight: .semibold))
            .foregroundStyle(Theme.Palette.textPrimary)
          Spacer(minLength: 0)
          IconButton(
            systemName: "xmark",
            label: "关闭设置",
            size: Theme.Metric.headerControlHeight,
            style: .circled,
            action: onClose
          )
        }
        .padding(.horizontal, Theme.Metric.settingsContentInset)
        .padding(.top, 16)
        .padding(.bottom, 10)

        ScrollView {
          content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Theme.Metric.settingsContentInset)
            .padding(.top, 6)
            .padding(.bottom, 32)
        }
        .scrollIndicators(.never)
      }
    }
    .frame(minWidth: 760, minHeight: 560)
    .background(Theme.Palette.surface)
  }
}

/// Title above a settings card.
public struct SettingsTitle: View {
  private let text: String

  public init(_ text: String) {
    self.text = text
  }

  public var body: some View {
    Text(text)
      .font(.system(size: 22, weight: .semibold))
      .foregroundStyle(Theme.Palette.textPrimary)
  }
}
