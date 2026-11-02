public struct ParticipantStatus: Equatable, Sendable {
  public enum Phase: Equatable, Sendable {
    case idle, working, connecting, attention, offline
  }

  public let label: String
  public let phase: Phase
  public let canStop: Bool
  public let canRecover: Bool
  /// The connection ended for good (the daemon is not running): the person starts it and
  /// asks again, instead of the client retrying on its own.
  public let canRetry: Bool
  public let error: String?

  public var isActive: Bool { phase == .working || phase == .connecting }

  /// The status reads as one filled glyph, coloured by what it means; the label stays for help
  /// and for VoiceOver instead of taking a line of its own.
  public var glyph: String {
    switch phase {
    case .idle: "checkmark.circle.fill"
    case .working: "bolt.fill"
    case .connecting: "clock.fill"
    case .attention: "exclamationmark.triangle.fill"
    case .offline: "stop.circle.fill"
    }
  }

  public init(
    label: String, phase: Phase, canStop: Bool = false,
    canRecover: Bool = false, canRetry: Bool = false, error: String? = nil
  ) {
    self.label = label
    self.phase = phase
    self.canStop = canStop
    self.canRecover = canRecover
    self.canRetry = canRetry
    self.error = error
  }
}
