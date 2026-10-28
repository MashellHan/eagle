import SwiftUI

/// Small version capsule, e.g. `v0.14.1`.
public struct VersionBadge: View {
  private let version: String

  public init(version: String) {
    self.version = version
  }

  @ViewBuilder
  private var mark: some View {
    if let image = BrandMark.image {
      Image(nsImage: image)
        .resizable()
        .interpolation(.high)
        .scaledToFill()
        .clipShape(Circle())
    } else {
      // Fallback keeps the header usable when the resource bundle is absent.
      Image(systemName: "bird")
        .font(.system(size: Theme.Metric.logoSize * 0.8, weight: .semibold))
        .foregroundStyle(Theme.Palette.textPrimary)
    }
  }

  public var body: some View {
    Text("v\(version)")
      .font(.system(size: 10.5, weight: .medium))
      .foregroundStyle(Theme.Palette.textMuted)
      .lineLimit(1)
      .fixedSize()
      .padding(.horizontal, 5)
      .padding(.vertical, 1.5)
      .background(Capsule().fill(Theme.Palette.hover.opacity(0.6)))
      .accessibilityLabel("版本 \(version)")
  }
}

/// Product identity for the sidebar: the bare eagle mark, the lowercase name and
/// a version badge. No plate, no texture, no avatar.
public struct BrandHeader: View {
  private let version: String
  private let onSearch: () -> Void
  private let onCompose: () -> Void
  /// A daemon group is a second kind of thing to create, so the + becomes a menu.
  private let onCreateGroup: (() -> Void)?
  private let canCompose: Bool
  private let onCollapse: () -> Void

  public init(
    version: String,
    onSearch: @escaping () -> Void = {},
    onCompose: @escaping () -> Void = {},
    onCreateGroup: (() -> Void)? = nil,
    canCompose: Bool = true,
    onCollapse: @escaping () -> Void = {}
  ) {
    self.version = version
    self.onSearch = onSearch
    self.onCompose = onCompose
    self.onCreateGroup = onCreateGroup
    self.canCompose = canCompose
    self.onCollapse = onCollapse
  }

  @ViewBuilder
  private var mark: some View {
    if let image = BrandMark.image {
      Image(nsImage: image)
        .resizable()
        .interpolation(.high)
        .scaledToFill()
        .clipShape(Circle())
    } else {
      // Fallback keeps the header usable when the resource bundle is absent.
      Image(systemName: "bird")
        .font(.system(size: Theme.Metric.logoSize * 0.8, weight: .semibold))
        .foregroundStyle(Theme.Palette.textPrimary)
    }
  }

  public var body: some View {
    HeaderRow {
      content
    }
  }

  private var content: some View {
    HStack(spacing: 6) {
      mark
        .frame(width: Theme.Metric.logoSize, height: Theme.Metric.logoSize)
        .accessibilityHidden(true)
      Text("eagle")
        .font(Theme.TypeScale.brand)
        .tracking(-0.4)
        .foregroundStyle(Theme.Palette.textPrimary)
      VersionBadge(version: version)
      Spacer(minLength: 8)
      IconButton(
        systemName: "magnifyingglass",
        label: "搜索",
        size: Theme.Metric.headerControlHeight,
        style: .circled,
        action: onSearch
      )
      if let onCreateGroup {
        MenuIconButton(
          systemName: "plus",
          label: "新建",
          size: Theme.Metric.headerControlHeight
        ) {
          Button(action: onCompose) {
            Label("新建 Bot", systemImage: "person.badge.plus")
          }
          .disabled(!canCompose)
          Button(action: onCreateGroup) {
            Label("新建分组", systemImage: "folder.badge.plus")
          }
          .disabled(!canCompose)
        }
      } else {
        IconButton(
          systemName: "plus",
          label: "新建会话",
          size: Theme.Metric.headerControlHeight,
          style: .circled,
          action: onCompose
        )
      }
      IconButton(
        systemName: "sidebar.left",
        label: "收起侧栏",
        size: Theme.Metric.headerControlHeight,
        style: .circled,
        action: onCollapse
      )
    }
    .padding(.leading, Theme.Metric.headerLeadingInset)
    .padding(.trailing, Theme.Metric.contentInset)
  }
}
