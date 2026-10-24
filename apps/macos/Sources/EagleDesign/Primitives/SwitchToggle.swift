import SwiftUI

/// Custom switch. SwiftUI's `Toggle(.switch)` ignores `.tint` on macOS and its
/// mini size does not match the reference, so the track is drawn directly.
public struct SwitchToggle: View {
  @Binding private var isOn: Bool
  private let label: String

  public init(isOn: Binding<Bool>, label: String) {
    self._isOn = isOn
    self.label = label
  }

  public var body: some View {
    Button {
      isOn.toggle()
    } label: {
      Capsule()
        .fill(isOn ? Theme.Palette.accentStrong : Theme.Palette.line)
        .frame(width: 34, height: 20)
        .overlay(alignment: isOn ? .trailing : .leading) {
          Circle()
            .fill(Theme.Palette.card)
            .frame(width: 16, height: 16)
            .padding(2)
            .shadow(color: .black.opacity(0.08), radius: 1, y: 0.5)
        }
        .animation(.easeOut(duration: 0.14), value: isOn)
    }
    .buttonStyle(.plain)
    .contentShape(Capsule())
    .accessibilityLabel(label)
    .accessibilityAddTraits(isOn ? [.isSelected] : [])
  }
}

/// Static green arc used by the typing row; deterministic so snapshots and the
/// offscreen renderer agree with the app.
public struct SpinnerArc: View {
  private let size: CGFloat
  private let lineWidth: CGFloat
  @LocalState private var spinning = false

  public init(size: CGFloat = 12, lineWidth: CGFloat = 1.6) {
    self.size = size
    self.lineWidth = lineWidth
  }

  public var body: some View {
    Circle()
      .trim(from: 0.12, to: 0.78)
      .stroke(
        Theme.Palette.accentStrong,
        style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
      )
      .frame(width: size, height: size)
      .rotationEffect(.degrees(spinning ? 360 : 0))
      .animation(
        .linear(duration: 0.9).repeatForever(autoreverses: false),
        value: spinning
      )
      .onAppear { spinning = true }
      .accessibilityHidden(true)
  }
}
