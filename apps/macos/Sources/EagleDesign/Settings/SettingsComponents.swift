import SwiftUI

/// Rounded white container used by every settings section.
public struct SettingsCard<Content: View>: View {
  private let content: Content

  public init(@ViewBuilder content: () -> Content) {
    self.content = content()
  }

  public var body: some View {
    content
      .padding(.horizontal, Theme.Metric.settingsCardInset)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: Theme.Metric.settingsCardRadius, style: .continuous)
          .fill(Theme.Palette.card)
      )
      .overlay(
        RoundedRectangle(cornerRadius: Theme.Metric.settingsCardRadius, style: .continuous)
          .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
      )
  }
}

/// Section heading above a card, e.g. `Bot 的电脑`.
public struct SettingsCaption: View {
  private let text: String

  public init(_ text: String) {
    self.text = text
  }

  public var body: some View {
    Text(text)
      .font(Theme.TypeScale.note)
      .foregroundStyle(Theme.Palette.textSecondary)
      .padding(.leading, 4)
  }
}

/// Bordered capsule that reads like a menu, e.g. `始终允许 ⌄`.
public struct PillMenu: View {
  private let title: String
  private let action: () -> Void
  @State private var hovering = false

  public init(_ title: String, action: @escaping () -> Void = {}) {
    self.title = title
    self.action = action
  }

  public var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        Text(title)
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(Theme.Palette.textPrimary)
        Image(systemName: "chevron.down")
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(Theme.Palette.textSecondary)
      }
      .padding(.horizontal, 14)
      .frame(height: 32)
      .background(Capsule().fill(hovering ? Theme.Palette.canvas : Theme.Palette.card))
      .overlay(Capsule().strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline))
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
  }
}

/// A capsule that opens a menu of choices: it looks like the pill above, but a click shows the
/// options instead of silently cycling the value.
public struct PillSelect<Value: Hashable>: View {
  public struct Option: Identifiable, Hashable {
    public let id: Value
    public let title: String

    public init(_ id: Value, _ title: String) {
      self.id = id
      self.title = title
    }
  }

  private let options: [Option]
  @Binding private var selection: Value
  @State private var hovering = false

  public init(options: [Option], selection: Binding<Value>) {
    self.options = options
    self._selection = selection
  }

  public var body: some View {
    Menu {
      ForEach(options) { option in
        Button {
          selection = option.id
        } label: {
          if option.id == selection {
            Label(option.title, systemImage: "checkmark")
          } else {
            Text(option.title)
          }
        }
      }
    } label: {
      HStack(spacing: 6) {
        Text(options.first { $0.id == selection }?.title ?? "")
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(Theme.Palette.textPrimary)
        Image(systemName: "chevron.down")
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(Theme.Palette.textSecondary)
      }
      .padding(.horizontal, 14)
      .frame(height: 32)
      .background(Capsule().fill(hovering ? Theme.Palette.canvas : Theme.Palette.card))
      .overlay(Capsule().strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline))
    }
    .menuStyle(.button)
    .buttonStyle(.plain)
    .menuIndicator(.hidden)
    .fixedSize()
    .onHover { hovering = $0 }
    .accessibilityLabel("外观")
  }
}

/// Light blue confirmation strip with a check icon.
public struct InfoBanner: View {
  private let text: String

  public init(_ text: String) {
    self.text = text
  }

  public var body: some View {
    HStack(spacing: 8) {
      Image(systemName: "checkmark.circle")
        .font(.system(size: 14, weight: .medium))
        .foregroundStyle(Theme.Palette.info)
      Text(text)
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(Theme.Palette.info)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 14)
    .frame(height: 40)
    .background(
      RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
        .fill(Theme.Palette.infoFill)
    )
  }
}

/// Filled red action, e.g. `重置`.
public struct DestructivePill: View {
  private let title: String
  private let action: () -> Void

  public init(_ title: String, action: @escaping () -> Void) {
    self.title = title
    self.action = action
  }

  public var body: some View {
    Button(action: action) {
      Text(title)
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(.white)
        .padding(.horizontal, 18)
        .frame(height: 34)
        .background(Capsule().fill(Theme.Palette.destructive))
    }
    .buttonStyle(.plain)
  }
}

/// Settings row with a label and a trailing control slot.
public struct SettingsRow<Trailing: View>: View {
  private let title: String
  private let detail: String?
  private let trailing: Trailing

  public init(_ title: String, detail: String? = nil, @ViewBuilder trailing: () -> Trailing) {
    self.title = title
    self.detail = detail
    self.trailing = trailing()
  }

  public var body: some View {
    HStack(alignment: .center, spacing: 16) {
      VStack(alignment: .leading, spacing: 3) {
        Text(title)
          .font(.system(size: 14))
          .foregroundStyle(Theme.Palette.textPrimary)
        if let detail {
          Text(detail)
            .font(Theme.TypeScale.note)
            .foregroundStyle(Theme.Palette.textSecondary)
        }
      }
      Spacer(minLength: 0)
      trailing
    }
    .frame(height: Theme.Metric.settingsRowHeight)
  }
}

/// A device row: icon, name with optional rename affordance, status line and
/// trailing controls.
public struct DeviceRow: View {
  private let symbol: String
  private let name: String
  private let status: String
  private let online: Bool
  private let permission: String
  private let onPermission: () -> Void
  private let onRename: (() -> Void)?
  private let onMore: () -> Void

  public init(
    symbol: String,
    name: String,
    status: String,
    online: Bool,
    permission: String,
    onPermission: @escaping () -> Void,
    onRename: (() -> Void)? = nil,
    onMore: @escaping () -> Void = {}
  ) {
    self.symbol = symbol
    self.name = name
    self.status = status
    self.online = online
    self.permission = permission
    self.onPermission = onPermission
    self.onRename = onRename
    self.onMore = onMore
  }

  public var body: some View {
    HStack(spacing: Theme.Metric.rowAvatarGap) {
      Image(systemName: symbol)
        .font(.system(size: 15, weight: .regular))
        .foregroundStyle(Theme.Palette.textSecondary)
        .frame(width: Theme.Metric.avatarRow)

      VStack(alignment: .leading, spacing: 5) {
        HStack(spacing: 6) {
          Text(name)
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(Theme.Palette.textPrimary)
          if let onRename {
            Button(action: onRename) {
              Image(systemName: "pencil")
                .font(.system(size: 11))
                .foregroundStyle(Theme.Palette.textSecondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("重命名 \(name)")
          }
        }
        HStack(spacing: 6) {
          Circle()
            .fill(online ? Theme.Palette.accentFill : Theme.Palette.textMuted)
            .frame(width: 6, height: 6)
          Text(status)
            .font(Theme.TypeScale.note)
            .foregroundStyle(Theme.Palette.textSecondary)
        }
      }

      Spacer(minLength: 12)

      PillMenu(permission, action: onPermission)
      IconButton(systemName: "ellipsis", label: "更多", action: onMore)
    }
    .frame(height: Theme.Metric.settingsDeviceRowHeight)
  }
}

/// A settings input with the app's own surface: rounded, fixed height, no native chrome.
/// The focus ring is a hairline in the accent, matching the shell's controls.
public struct SettingsTextField: View {
  private let placeholder: String
  @Binding private var text: String
  private let secure: Bool
  @FocusState private var focused: Bool

  public init(_ placeholder: String, text: Binding<String>, secure: Bool = false) {
    self.placeholder = placeholder
    self._text = text
    self.secure = secure
  }

  public var body: some View {
    HStack(spacing: 6) {
      Group {
        if secure {
          SecureField("", text: $text)
        } else {
          TextField("", text: $text)
        }
      }
      .textFieldStyle(.plain)
      .font(.system(size: 13.5))
      .foregroundStyle(Theme.Palette.textPrimary)
      .focused($focused)
      if !secure, !text.isEmpty {
        Button {
          text = ""
        } label: {
          Image(systemName: "xmark.circle.fill")
            .font(.system(size: 12))
            .foregroundStyle(Theme.Palette.textMuted)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("清除")
      }
    }
    .padding(.horizontal, 11)
    .frame(height: 34)
    .background(
      RoundedRectangle(cornerRadius: 9, style: .continuous)
        .fill(Theme.Palette.canvas)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 9, style: .continuous)
        .strokeBorder(
          focused ? Theme.Palette.accent.opacity(0.65) : Theme.Palette.line,
          lineWidth: Theme.Metric.hairline
        )
    )
    .overlay(alignment: .leading) {
      if text.isEmpty {
        Text(placeholder)
          .font(.system(size: 13.5))
          .foregroundStyle(Theme.Palette.textMuted)
          .padding(.leading, 12)
          .allowsHitTesting(false)
      }
    }
    .contentShape(Rectangle())
    .onTapGesture { focused = true }
  }
}

/// A compact settings button: a soft surface by default, the accent when primary.
public struct SettingsActionButton: View {
  private let title: String
  private let action: () -> Void
  private let prominent: Bool
  @State private var hovering = false

  public init(_ title: String, prominent: Bool = false, action: @escaping () -> Void) {
    self.title = title
    self.action = action
    self.prominent = prominent
  }

  public var body: some View {
    Button(action: action) {
      Text(title)
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(prominent ? Color.white : Theme.Palette.textPrimary)
        .padding(.horizontal, 14)
        .frame(height: 30)
        .background(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(
              prominent
                ? Theme.Palette.accentStrong
                : (hovering ? Theme.Palette.line : Theme.Palette.canvas)
            )
        )
        .overlay(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .strokeBorder(prominent ? .clear : Theme.Palette.line, lineWidth: Theme.Metric.hairline)
        )
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
  }
}
