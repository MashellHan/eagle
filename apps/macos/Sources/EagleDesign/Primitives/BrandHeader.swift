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

/// Product identity for the sidebar: the bare eagle mark, the lowercase name and a version
/// badge. The mark sits on the same content line as the bot rows' avatars, so the identity
/// reads as the first row of the list. No plate, no texture, no avatar.
public struct BrandHeader: View {
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
    HStack(spacing: Theme.Metric.brandMarkGap) {
      mark
        .frame(width: Theme.Metric.logoSize, height: Theme.Metric.logoSize)
        .accessibilityHidden(true)
      Text("eagle")
        .font(Theme.TypeScale.brand)
        .tracking(-0.4)
        .foregroundStyle(Theme.Palette.textPrimary)
        .lineLimit(1)
      VersionBadge(version: version)
      Spacer(minLength: 0)
    }
    .frame(height: Theme.Metric.logoSize)
  }
}
