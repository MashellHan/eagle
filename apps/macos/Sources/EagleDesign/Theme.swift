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
    public static let textPrimary = Color(srgb: 0x252525)
    public static let textSecondary = Color(srgb: 0x757575)
    /// Row subtitles and the plan line: lighter than the section labels.
    public static let textMuted = Color(srgb: 0xA7A7A7)
    public static let accent = Color(srgb: 0x3B7DCD)
    /// Info banner (blue text on a pale blue fill).
    public static let info = Color(srgb: 0x2F6FD0)
    public static let infoFill = Color(srgb: 0xEDF3FC)
    public static let destructive = Color(srgb: 0xE5484D)
    public static let accentFill = Color(srgb: 0x4FA46A)
    public static let accentStrong = Color(srgb: 0x58B378)
    public static let hover = Color(srgb: 0x000000).opacity(0.05)
    public static let selection = Color(srgb: 0xFFFFFF)

    /// Avatar tints observed in the reference list, in rotation order.
    public static let avatarTints: [Color] = [
      Color(srgb: 0xEC5858),
      Color(srgb: 0x5098F4),
      Color(srgb: 0x64C0B0),
      Color(srgb: 0xF08840),
      Color(srgb: 0x9878F4),
      Color(srgb: 0xEC60A4),
      Color(srgb: 0x68C488),
    ]

    public static func avatarTint(_ index: Int) -> Color {
      avatarTints[abs(index) % avatarTints.count]
    }
  }

  public enum Metric {
    // Window and columns, measured from the reference screenshot in points.
    public static let windowWidth: CGFloat = 1728
    public static let windowHeight: CGFloat = 1082
    public static let sidebarWidth: CGFloat = 374
    public static let sidebarMinWidth: CGFloat = 300
    public static let sidebarMaxWidth: CGFloat = 560
    public static let inspectorWidth: CGFloat = 319
    public static let inspectorMinWidth: CGFloat = 280
    public static let inspectorMaxWidth: CGFloat = 460

    /// Traffic lights: 13.5 pt circles at (16, 15) with a 23 pt pitch.
    public static let trafficLightInset: CGFloat = 15
    public static let trafficLightsEnd: CGFloat = 75
    public static let toolbarHeight: CGFloat = 36

    /// Sidebar grid: 20 pt content inset, 34 pt rows avatars, 58 pt row pitch.
    public static let contentInset: CGFloat = 20
    public static let rowHeight: CGFloat = 58
    public static let rowAvatarGap: CGFloat = 11
    public static let sectionHeaderHeight: CGFloat = 24
    public static let sectionGap: CGFloat = 22
    public static let profileTop: CGFloat = 22
    public static let chipTopInset: CGFloat = 6
    public static let pinnedHeaderHeight: CGFloat = 70
    public static let toolbarTopInset: CGFloat = 12
    public static let profileAvatar: CGFloat = 55
    public static let profileNameGap: CGFloat = 8
    public static let listTopGap: CGFloat = 34
    public static let unreadPillHeight: CGFloat = 28
    public static let unreadPillBottom: CGFloat = 16
    public static let footerHeight: CGFloat = 62
    public static let footerBottom: CGFloat = 16

    public static let panelInset: CGFloat = 16
    public static let conversationInset: CGFloat = 24
    public static let turnGap: CGFloat = 24
    public static let inspectorRowHeight: CGFloat = 40
    public static let composerHeight: CGFloat = 54
    public static let composerBottomInset: CGFloat = 14
    public static let windowInset: CGFloat = 8

    public static let avatarRow: CGFloat = 34
    public static let avatarProfile: CGFloat = profileAvatar
    public static let avatarInspector: CGFloat = 76
    public static let avatarNote: CGFloat = 18
    public static let iconButton: CGFloat = 30
    public static let hitTarget: CGFloat = 28

    public static let cardRadius: CGFloat = 12
    public static let controlRadius: CGFloat = 9
    public static let hairline: CGFloat = 1

    public static let collapseDuration: CGFloat = 0.28
    public static let settingsRailWidth: CGFloat = 190
    public static let settingsRowHeight: CGFloat = 46
    public static let settingsDeviceRowHeight: CGFloat = 58
    public static let settingsCardRadius: CGFloat = 14
    public static let settingsCardInset: CGFloat = 20
    public static let settingsContentInset: CGFloat = 28
    public static let accountMenuWidth: CGFloat = 226
    public static let accountRowHeight: CGFloat = 46
    public static let conversationMaxContentWidth: CGFloat = 720
  }

  public enum TypeScale {
    public static let rowTitle = Font.system(size: 15, weight: .medium)
    public static let rowSubtitle = Font.system(size: 13.5)
    public static let sectionLabel = Font.system(size: 13.5, weight: .medium)
    public static let profileName = Font.system(size: 13.5, weight: .semibold)
    public static let profilePlan = Font.system(size: 12.5)
    public static let body = Font.system(size: 15)
    public static let bodyEmphasis = Font.system(size: 15, weight: .medium)
    public static let bubble = Font.system(size: 15)
    public static let note = Font.system(size: 13)
    public static let composer = Font.system(size: 15)
    public static let inspectorTitle = Font.system(size: 18, weight: .semibold)
    public static let cardTitle = Font.system(size: 14, weight: .medium)
    public static let mono = Font.system(size: 13, design: .monospaced)
    public static let pill = Font.system(size: 11.5, weight: .medium)
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
