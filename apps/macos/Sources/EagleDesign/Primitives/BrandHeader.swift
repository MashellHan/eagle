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
        .scaledToFit()
    } else {
      // Fallback keeps the header usable when the resource bundle is absent.
      Image(systemName: "bird")
        .font(.system(size: Theme.Metric.logoSize * 0.8, weight: .semibold))
        .foregroundStyle(Theme.Palette.textPrimary)
    }
  }

  public var body: some View {
    Text("v\(version)")
      .font(Theme.TypeScale.pill)
      .foregroundStyle(Theme.Palette.textSecondary)
      .padding(.horizontal, 6)
      .padding(.vertical, 2)
      .background(Capsule().fill(Theme.Palette.hover))
      .accessibilityLabel("版本 \(version)")
  }
}

/// Product identity for the sidebar: the bare eagle mark, the lowercase name and
/// a version badge. No plate, no texture, no avatar.
public struct BrandHeader: View {
  private let version: String
  private let onSearch: () -> Void
  private let onCompose: () -> Void
  private let onCollapse: () -> Void

  public init(
    version: String,
    onSearch: @escaping () -> Void = {},
    onCompose: @escaping () -> Void = {},
    onCollapse: @escaping () -> Void = {}
  ) {
    self.version = version
    self.onSearch = onSearch
    self.onCompose = onCompose
    self.onCollapse = onCollapse
  }

  @ViewBuilder
  private var mark: some View {
    if let image = BrandMark.image {
      Image(nsImage: image)
        .resizable()
        .interpolation(.high)
        .scaledToFit()
    } else {
      // Fallback keeps the header usable when the resource bundle is absent.
      Image(systemName: "bird")
        .font(.system(size: Theme.Metric.logoSize * 0.8, weight: .semibold))
        .foregroundStyle(Theme.Palette.textPrimary)
    }
  }

  public var body: some View {
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
        systemName: "magnifyingglass", label: "搜索", style: .circled, action: onSearch)
      IconButton(systemName: "plus", label: "新建会话", style: .circled, action: onCompose)
      IconButton(
        systemName: "sidebar.left", label: "收起侧栏", style: .circled, action: onCollapse)
    }
    .padding(.horizontal, Theme.Metric.contentInset)
    .padding(.top, Theme.Metric.toolbarTopInset)
    .frame(height: Theme.Metric.toolbarTopInset + Theme.Metric.headerHeight)
  }
}
