import SwiftUI

/// Rounded white composer: attach, text field, mic and waveform actions.
public struct Composer: View {
  private let placeholder: String
  @Binding private var text: String
  private let onSend: () -> Void
  private let onAttach: () -> Void
  private let onMic: () -> Void
  private let onWaveform: () -> Void

  public init(
    placeholder: String,
    text: Binding<String>,
    onSend: @escaping () -> Void,
    onAttach: @escaping () -> Void = {},
    onMic: @escaping () -> Void = {},
    onWaveform: @escaping () -> Void = {}
  ) {
    self.placeholder = placeholder
    self._text = text
    self.onSend = onSend
    self.onAttach = onAttach
    self.onMic = onMic
    self.onWaveform = onWaveform
  }

  public var body: some View {
    HStack(alignment: .bottom, spacing: 8) {
      IconButton(systemName: "plus", label: "添加附件", size: 28, action: onAttach)

      TextField(
        "",
        text: $text,
        prompt: Text(placeholder).foregroundStyle(Theme.Palette.textSecondary),
        axis: .vertical
      )
      .textFieldStyle(.plain)
      .font(Theme.TypeScale.composer)
      .foregroundStyle(Theme.Palette.textPrimary)
      .lineLimit(1...3)
      .fixedSize(horizontal: false, vertical: true)
      .frame(minHeight: Theme.Metric.hitTarget)
      .onSubmit(onSend)
      .accessibilityLabel(placeholder)

      IconButton(
        systemName: "mic", label: "语音输入", size: 28, tint: Theme.Palette.textSecondary, action: onMic
      )
      IconButton(
        systemName: "waveform",
        label: "发送",
        size: 28,
        tint: text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          ? Theme.Palette.textSecondary
          : Theme.Palette.accentFill,
        action: onSend
      )
    }
    .padding(.horizontal, 14)
    .padding(.vertical, Theme.Metric.composerVerticalInset)
    .frame(minHeight: Theme.Metric.composerHeight)
    .background(
      RoundedRectangle(cornerRadius: Theme.Metric.composerHeight / 2, style: .continuous)
        .fill(Theme.Palette.card)
    )
    .overlay(
      RoundedRectangle(cornerRadius: Theme.Metric.composerHeight / 2, style: .continuous)
        .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
    )
  }
}
