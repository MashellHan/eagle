import BotsCore
import EagleDesign
import SwiftUI

/// The create form: a name (required), an optional label, and the face the user picks.
/// It is a sheet on the main window, not a second window.
struct BotCreateSheet: View {
  let onCreate: (String, String?, BotAppearance) -> Void
  let onCancel: () -> Void

  @State private var name = ""
  @State private var label = ""
  @State private var shape: BotFace.Shape = .blob
  @State private var tint: Theme.Palette.BotTint = .green
  @FocusState private var nameFocused: Bool

  private var canCreate: Bool {
    !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  var body: some View {
    VStack(spacing: 0) {
      header
      Divider().overlay(Theme.Palette.line)
      ScrollView {
        VStack(spacing: 18) {
          BotFace(style: BotFace.Style(shape: shape, tint: tint), size: 132)
            .padding(.top, 18)
          fields
          shapes
          tints
        }
        .padding(.horizontal, Theme.Metric.settingsCardInset)
        .padding(.bottom, 18)
      }
      Divider().overlay(Theme.Palette.line)
      footer
    }
    .frame(width: 560, height: 640)
    .background(Theme.Palette.surface)
    .onAppear { nameFocused = true }
  }

  private var header: some View {
    HStack {
      Text("创建新 Bot")
        .font(Theme.TypeScale.inspectorTitle)
      Spacer()
      IconButton(systemName: "xmark", label: "关闭", size: 28, action: onCancel)
    }
    .padding(.horizontal, Theme.Metric.settingsCardInset)
    .padding(.vertical, 14)
  }

  private var fields: some View {
    VStack(spacing: 8) {
      TextField(
        "",
        text: $name,
        prompt: Text("给你的 Bot 起个名字").foregroundStyle(Theme.Palette.textSecondary)
      )
      .textFieldStyle(.plain)
      .font(Theme.TypeScale.body)
      .focused($nameFocused)
      .padding(.horizontal, 14)
      .frame(height: 44)
      .background(fieldBackground)
      .onSubmit { create() }

      TextField(
        "",
        text: $label,
        prompt: Text("标签（可选）").foregroundStyle(Theme.Palette.textSecondary)
      )
      .textFieldStyle(.plain)
      .font(Theme.TypeScale.note)
      .padding(.horizontal, 14)
      .frame(height: 36)
      .background(fieldBackground)
    }
  }

  private var shapes: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("形状")
        .font(Theme.TypeScale.sectionLabel)
        .foregroundStyle(Theme.Palette.textSecondary)
      LazyVGrid(
        columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 8),
        spacing: 10
      ) {
        ForEach(BotFace.Shape.allCases, id: \.self) { candidate in
          Button {
            shape = candidate
          } label: {
            BotFace(style: BotFace.Style(shape: candidate, tint: tint), size: 40)
              .padding(4)
              .background(
                RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
                  .strokeBorder(
                    candidate == shape ? Theme.Palette.accent : .clear,
                    lineWidth: 2
                  )
              )
          }
          .buttonStyle(.plain)
          .help(candidate.rawValue)
        }
      }
    }
  }

  private var tints: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("颜色")
        .font(Theme.TypeScale.sectionLabel)
        .foregroundStyle(Theme.Palette.textSecondary)
      LazyVGrid(
        columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 6),
        spacing: 10
      ) {
        ForEach(Theme.Palette.BotTint.allCases, id: \.self) { candidate in
          Button {
            tint = candidate
          } label: {
            Circle()
              .fill(Theme.Palette.botTint(candidate))
              .frame(width: 28, height: 28)
              .padding(4)
              .overlay(
                Circle()
                  .strokeBorder(
                    candidate == tint ? Theme.Palette.textPrimary.opacity(0.6) : .clear,
                    lineWidth: 2
                  )
              )
          }
          .buttonStyle(.plain)
          .help(candidate.rawValue)
        }
      }
    }
  }

  private var footer: some View {
    HStack {
      Spacer()
      Button("取消", action: onCancel)
        .buttonStyle(.bordered)
        .keyboardShortcut(.cancelAction)
      Button("创建") { create() }
        .buttonStyle(.borderedProminent)
        .tint(Theme.Palette.accentFill)
        .disabled(!canCreate)
        .keyboardShortcut(.defaultAction)
    }
    .padding(.horizontal, Theme.Metric.settingsCardInset)
    .padding(.vertical, 12)
  }

  private var fieldBackground: some View {
    RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
      .fill(Theme.Palette.card)
      .overlay(
        RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
          .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
      )
  }

  private func create() {
    guard canCreate else { return }
    let trimmedLabel = label.trimmingCharacters(in: .whitespacesAndNewlines)
    onCreate(
      name.trimmingCharacters(in: .whitespacesAndNewlines),
      trimmedLabel.isEmpty ? nil : trimmedLabel,
      BotAppearance(
        shape: BotAppearance.Shape(rawValue: shape.rawValue) ?? .blob,
        tint: BotAppearance.Tint(rawValue: tint.rawValue) ?? .green
      )
    )
  }
}
