import SwiftUI

/// Single top container for the whole window: brand identity on the left, the
/// participant bubble in the centre and the action groups on the right. The
/// columns below start under this strip, so collapsing a panel never moves the
/// bubble.
public struct WindowHeader<Center: View>: View {
  private let version: String
  private let onSearch: () -> Void
  private let onCompose: () -> Void
  private let showsSidebar: Bool
  private let showsInspector: Bool
  private let onToggleSidebar: () -> Void
  private let onToggleInspector: () -> Void
  private let center: Center

  public init(
    version: String,
    showsSidebar: Bool,
    showsInspector: Bool,
    onSearch: @escaping () -> Void = {},
    onCompose: @escaping () -> Void = {},
    onToggleSidebar: @escaping () -> Void = {},
    onToggleInspector: @escaping () -> Void = {},
    @ViewBuilder center: () -> Center
  ) {
    self.version = version
    self.showsSidebar = showsSidebar
    self.showsInspector = showsInspector
    self.onSearch = onSearch
    self.onCompose = onCompose
    self.onToggleSidebar = onToggleSidebar
    self.onToggleInspector = onToggleInspector
    self.center = center()
  }

  public var body: some View {
    ZStack {
      HStack(spacing: 6) {
        brand
        Spacer(minLength: 12)
        IconButton(
          systemName: "magnifyingglass", label: "搜索", style: .circled, action: onSearch)
        IconButton(
          systemName: "plus", label: "新建会话", style: .circled, action: onCompose)
        IconButton(
          systemName: "sidebar.left",
          label: showsSidebar ? "收起侧栏" : "展开侧栏",
          tint: showsSidebar ? Theme.Palette.textPrimary : Theme.Palette.textMuted,
          style: .circled,
          action: onToggleSidebar
        )
        IconButton(
          systemName: "sidebar.right",
          label: showsInspector ? "收起检查器" : "展开检查器",
          tint: showsInspector ? Theme.Palette.textPrimary : Theme.Palette.textMuted,
          style: .circled,
          action: onToggleInspector
        )
      }
      .padding(.leading, Theme.Metric.headerLeadingInset)
      .padding(.trailing, Theme.Metric.panelInset)

      center
    }
    .padding(.bottom, Theme.Metric.headerBottomInset)
    .frame(height: Theme.Metric.headerHeight, alignment: .bottom)
    .background(Theme.Palette.surface)
    .overlay(alignment: .bottom) {
      Rectangle()
        .fill(Theme.Palette.line)
        .frame(height: Theme.Metric.hairline)
    }
  }

  private var brand: some View {
    HStack(spacing: 8) {
      mark
        .frame(width: Theme.Metric.logoSize, height: Theme.Metric.logoSize)
        .accessibilityHidden(true)
      Text("eagle")
        .font(Theme.TypeScale.brand)
        .tracking(-0.4)
        .foregroundStyle(Theme.Palette.textPrimary)
        .lineLimit(1)
        .fixedSize()
      VersionBadge(version: version)
    }
  }

  @ViewBuilder
  private var mark: some View {
    if let image = BrandMark.image {
      Image(nsImage: image)
        .resizable()
        .interpolation(.high)
        .scaledToFit()
    } else {
      Image(systemName: "bird")
        .font(.system(size: Theme.Metric.logoSize * 0.8, weight: .semibold))
        .foregroundStyle(Theme.Palette.textPrimary)
    }
  }
}
