import SwiftUI

/// Visual reference for every token and component. Used while the shell is
/// still being aligned to the reference design.
public struct TemplateGallery: View {
  @LocalState private var tab: InspectorColumn.Tab = .detail
  @LocalState private var toggleOne = true
  @LocalState private var toggleTwo = true
  @LocalState private var draft = ""
  @LocalState private var draftFilled = "把 sleepy 那个 PR 一起并掉"

  public init() {}

  public var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 28) {
        header
        paletteSection
        typographySection
        primitivesSection
        chatSection
        panelSection
      }
      .padding(28)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(Theme.Palette.surface)
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text("Eagle 模板库")
        .font(.system(size: 19, weight: .semibold))
        .foregroundStyle(Theme.Palette.textPrimary)
      Text("颜色、字号与控件均按 Grok Bot 参考图对齐；默认系统字体。")
        .font(Theme.TypeScale.rowSubtitle)
        .foregroundStyle(Theme.Palette.textSecondary)
    }
  }

  private var paletteSection: some View {
    GalleryCard(title: "配色") {
      LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 5), spacing: 12) {
        swatch("canvas", Theme.Palette.canvas, "F4F4F4")
        swatch("surface", Theme.Palette.surface, "FCFCFC")
        swatch("card", Theme.Palette.card, "FFFFFF")
        swatch("line", Theme.Palette.line, "EEEEEE")
        swatch("textPrimary", Theme.Palette.textPrimary, "252525")
        swatch("textSecondary", Theme.Palette.textSecondary, "757575")
        swatch("accent", Theme.Palette.accent, "3B7DCD")
        swatch("accentFill", Theme.Palette.accentFill, "55A471")
        swatch("accentStrong", Theme.Palette.accentStrong, "5DB57B")
        swatch("hover", Theme.Palette.hover, "000000/4.5%")
      }
    }
  }

  private var typographySection: some View {
    GalleryCard(title: "字号") {
      VStack(alignment: .leading, spacing: 10) {
        row("行标题 13 semibold", Theme.TypeScale.rowTitle)
        row("行副标题 12 regular", Theme.TypeScale.rowSubtitle)
        row("区块标签 11 medium", Theme.TypeScale.sectionLabel)
        row("正文 13 regular", Theme.TypeScale.body)
        row("气泡文字 13", Theme.TypeScale.bubble)
        row("提示 11", Theme.TypeScale.note)
        row("检查器标题 15 semibold", Theme.TypeScale.inspectorTitle)
        row("卡片标题 12 medium", Theme.TypeScale.cardTitle)
        row("等宽 12", Theme.TypeScale.mono)
      }
    }
  }

  private var primitivesSection: some View {
    GalleryCard(title: "基础控件") {
      VStack(alignment: .leading, spacing: 18) {
        HStack(spacing: 12) {
          Avatar(initial: "监", tint: Theme.Palette.avatarTint(1), size: Theme.Metric.avatarProfile, badge: Theme.Palette.avatarTint(3))
          Avatar(initial: "G", tint: Theme.Palette.accentStrong, size: Theme.Metric.avatarProfile, shape: .blob)
          ForEach(Array(Theme.Palette.avatarTints.enumerated()), id: \.offset) { index, tint in
            Avatar(initial: "依", tint: tint)
          }
          Spacer(minLength: 0)
        }

        HStack(spacing: 12) {
          Text("工作秘书").font(Theme.TypeScale.rowTitle).foregroundStyle(Theme.Palette.textPrimary)
          Tag("Personal")
          Tag("GitHub")
          Spacer(minLength: 0)
        }

        HStack(spacing: 14) {
          IconButton(systemName: "magnifyingglass", label: "搜索") {}
          IconButton(systemName: "plus", label: "新建会话") {}
          IconButton(systemName: "square.and.arrow.up", label: "分享") {}
          IconButton(systemName: "xmark", label: "关闭") {}
          TextAction("更多未读消息") {}
          Spacer(minLength: 0)
        }

        SectionLabel("新闻组", count: 9)

        SegmentedTabs(values: InspectorColumn.Tab.allCases, selection: $tab) { $0.rawValue }
          .frame(maxWidth: 320)

        VStack(spacing: 8) {
          ChevronRow(systemName: "chevron.left.forwardslash.chevron.right", title: "deps 2026-10-24 sleepy") {}
          ToggleRow(title: "每日依赖修复调度", detail: "每天 8:47", isOn: $toggleOne)
          ToggleRow(title: "依赖修复进度 10-24", detail: "每小时，10月24日，10:00 – 20:00", isOn: $toggleTwo)
        }
        .frame(maxWidth: 320)
      }
    }
  }

  private var chatSection: some View {
    GalleryCard(title: "会话") {
      VStack(alignment: .leading, spacing: Theme.Metric.turnGap) {
        AssistantTurn([
          .bullets(["firefly: 5 / 2, 有 CVE", "octo: 5 / 2, 有 CVE", "zhe: 11 / 2, 有 CVE"]),
          .paragraph("第一批 8 个仓库已经开始修了，每小时给你发一次进度。"),
        ])
        DeliveryNote("2 条消息往来：", avatars: Array(Theme.Palette.avatarTints.prefix(2)))
        UserBubble("今天 eagle 会修吗")
        TypingIndicator()
        Composer(placeholder: "给 依赖修复专家 发消息", text: $draft) {}
        Composer(placeholder: "给 依赖修复专家 发消息", text: $draftFilled) {}
      }
    }
  }

  private var panelSection: some View {
    GalleryCard(title: "栏目") {
      HStack(alignment: .top, spacing: 16) {
        SidebarPanel(
          profileInitial: "监",
          profileName: "监察御史",
          profilePlan: "Personal",
          sections: [
            SidebarSection(id: "s", title: "秘书处", items: [
              SidebarItem(id: "1", title: "首席调查官", subtitle: "哥，最值得借鉴的是 OpenClaw 的聊天界面模块...", tintIndex: 0),
              SidebarItem(id: "2", title: "工作秘书", subtitle: "哥，周末早上有两件事：", tag: "Personal", tintIndex: 1),
            ]),
            SidebarSection(id: "n", title: "新闻组", count: 9, items: [
              SidebarItem(id: "3", title: "知识库", subtitle: "哥，我查过了：翻墙大师的知识库 key 现在只能...", tintIndex: 5),
            ]),
          ],
          selection: "2",
          onSelect: { _ in },
          unreadCount: 2
        )
        .frame(height: 620)
        .overlay(alignment: .topTrailing) { cornerLabel("411 × 620") }

        InspectorColumn(
          name: "依赖修复专家",
          subtitle: "GitHub",
          tintIndex: 2,
          artifacts: [
            InspectorArtifact(id: "1", title: "deps 2026-10-24 sleepy"),
            InspectorArtifact(id: "2", title: "deps 2026-10-24 next-ai"),
            InspectorArtifact(id: "3", title: "deps 2026-10-24 meowth"),
          ],
          jobs: [
            InspectorJob(id: "j1", title: "每日依赖修复调度", detail: "每天 8:47", isOn: true),
            InspectorJob(id: "j2", title: "依赖修复进度 10-24", detail: "每小时，10月24日，10:00 – 20:00", isOn: true),
          ],
          tab: .constant(.detail)
        )
        .frame(height: 620)
        .overlay(alignment: .topTrailing) { cornerLabel("330 × 620") }
      }
    }
  }

  private func swatch(_ name: String, _ color: Color, _ hex: String) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .fill(color)
        .frame(height: 44)
        .overlay(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
        )
      Text(name).font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textPrimary)
      Text(hex).font(Theme.TypeScale.mono).foregroundStyle(Theme.Palette.textSecondary)
    }
  }

  private func row(_ text: String, _ font: Font) -> some View {
    Text(text)
      .font(font)
      .foregroundStyle(Theme.Palette.textPrimary)
  }

  private func cornerLabel(_ text: String) -> some View {
    Text(text)
      .font(Theme.TypeScale.pill)
      .foregroundStyle(Theme.Palette.textSecondary)
      .padding(.horizontal, 6)
      .padding(.vertical, 2)
      .background(Capsule().fill(Theme.Palette.card))
      .overlay(Capsule().strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline))
      .padding(8)
  }
}

private struct GalleryCard<Content: View>: View {
  private let title: String
  private let content: Content

  init(title: String, @ViewBuilder content: () -> Content) {
    self.title = title
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      SectionLabel(title)
      content
    }
    .padding(16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.Palette.card)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
    )
  }
}
