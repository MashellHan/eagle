import SwiftUI

/// Design tokens sampled from the Grok Bot desktop reference, then lightened:
/// the first pass read too grey and too small, so surfaces are now near-white,
/// body text is 14 pt and paddings are wider.
public enum Theme {
  public enum Palette {
    public static let canvas = Color(srgb: 0xF7F7F5)
    public static let surface = Color(srgb: 0xFFFFFF)
    public static let card = Color(srgb: 0xFFFFFF)
    public static let line = Color(srgb: 0xECECEA)
    public static let textPrimary = Color(srgb: 0x1F1F1D)
    public static let textSecondary = Color(srgb: 0x84847F)
    public static let accent = Color(srgb: 0x3B7DCD)
    public static let accentFill = Color(srgb: 0x4FA46A)
    public static let accentStrong = Color(srgb: 0x58B378)
    public static let hover = Color(srgb: 0x000000).opacity(0.05)
    public static let selection = Color(srgb: 0xFFFFFF)

    /// Avatar tints observed in the reference list, in rotation order.
    public static let avatarTints: [Color] = [
      Color(srgb: 0xE4564A),
      Color(srgb: 0x4A7DE4),
      Color(srgb: 0x3FAE72),
      Color(srgb: 0xE1893C),
      Color(srgb: 0xD7528F),
      Color(srgb: 0x8B5CF6),
      Color(srgb: 0xC0504E),
      Color(srgb: 0x2FA3A3),
    ]

    public static func avatarTint(_ index: Int) -> Color {
      avatarTints[abs(index) % avatarTints.count]
    }
  }

  public enum Metric {
    public static let sidebarWidth: CGFloat = 411
    public static let inspectorWidth: CGFloat = 330
    public static let conversationMaxContentWidth: CGFloat = 720

    /// Room for the traffic lights when the title bar is hidden.
    public static let trafficLightInset: CGFloat = 30
    public static let headerHeight: CGFloat = 48
    public static let sidebarInset: CGFloat = 22
    public static let rowInset: CGFloat = 12
    public static let panelInset: CGFloat = 26
    public static let conversationInset: CGFloat = 40
    public static let sectionGap: CGFloat = 24
    public static let sectionHeaderHeight: CGFloat = 30
    public static let turnGap: CGFloat = 28

    public static let rowHeight: CGFloat = 48
    public static let inspectorRowHeight: CGFloat = 38
    public static let composerHeight: CGFloat = 52
    public static let composerBottomInset: CGFloat = 24

    public static let avatarRow: CGFloat = 32
    public static let avatarProfile: CGFloat = 60
    public static let avatarInspector: CGFloat = 72
    public static let avatarNote: CGFloat = 16
    public static let iconButton: CGFloat = 30
    public static let hitTarget: CGFloat = 26

    public static let cardRadius: CGFloat = 12
    public static let controlRadius: CGFloat = 9
    public static let hairline: CGFloat = 1

    public static let collapseDuration: CGFloat = 0.28
  }

  public enum TypeScale {
    public static let rowTitle = Font.system(size: 14, weight: .semibold)
    public static let rowSubtitle = Font.system(size: 13)
    public static let sectionLabel = Font.system(size: 12, weight: .medium)
    public static let body = Font.system(size: 14)
    public static let bodyEmphasis = Font.system(size: 14, weight: .medium)
    public static let bubble = Font.system(size: 14)
    public static let note = Font.system(size: 12)
    public static let composer = Font.system(size: 14)
    public static let inspectorTitle = Font.system(size: 17, weight: .semibold)
    public static let cardTitle = Font.system(size: 13, weight: .medium)
    public static let mono = Font.system(size: 12.5, design: .monospaced)
    public static let pill = Font.system(size: 11, weight: .medium)
  }
}

extension Color {
  /// sRGB token helper so palette values stay readable in source.
  init(srgb value: UInt32) {
    self.init(
      .sRGB,
      red: Double((value >> 16) & 0xFF) / 255,
      green: Double((value >> 8) & 0xFF) / 255,
      blue: Double(value & 0xFF) / 255,
      opacity: 1
    )
  }
}
