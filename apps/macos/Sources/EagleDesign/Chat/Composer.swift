import SwiftUI

/// Rounded white composer: attach, text field, mic and waveform actions.
public struct Composer: View {
  private let placeholder: String
  @Binding private var text: String
  private let onSend: () -> Void
  /// Steers the running answer; nil while there is nothing to steer.
  private let onInsert: (() -> Void)?
  private let onAttach: () -> Void
  private let onMic: () -> Void
  private let onWaveform: () -> Void
  private let autofocus: Bool
  private let focusRequest: Int
  @FocusState private var focused: Bool

  public init(
    placeholder: String,
    text: Binding<String>,
    onSend: @escaping () -> Void,
    onInsert: (() -> Void)? = nil,
    onAttach: @escaping () -> Void = {},
    onMic: @escaping () -> Void = {},
    onWaveform: @escaping () -> Void = {},
    autofocus: Bool = false,
    focusRequest: Int = 0
  ) {
    self.placeholder = placeholder
    self._text = text
    self.onSend = onSend
    self.onInsert = onInsert
    self.onAttach = onAttach
    self.onMic = onMic
    self.onWaveform = onWaveform
    self.autofocus = autofocus
    self.focusRequest = focusRequest
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
      .focused($focused)
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
    // ⌘↩ steers the running answer. A hidden button carries the shortcut so the field keeps
    // its Return behaviour; the hint above the composer tells a person it exists.
    .background {
      if let onInsert {
        Button("插入当前回答", action: onInsert)
          .keyboardShortcut(.return, modifiers: .command)
          .opacity(0)
          .frame(width: 0, height: 0)
          .accessibilityHidden(true)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, Theme.Metric.composerVerticalInset)
    .frame(minHeight: Theme.Metric.composerHeight)
    .background(
      RoundedRectangle(cornerRadius: Theme.Metric.composerHeight / 2, style: .continuous)
        .fill(Theme.Palette.card)
        .onTapGesture { focused = true }
    )
    .overlay(
      RoundedRectangle(cornerRadius: Theme.Metric.composerHeight / 2, style: .continuous)
        .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
        .allowsHitTesting(false)
    )
    .task {
      guard autofocus else { return }
      await Task.yield()
      guard !Task.isCancelled else { return }
      focused = true
    }
    .onChange(of: focusRequest) { focused = true }
  }
}
