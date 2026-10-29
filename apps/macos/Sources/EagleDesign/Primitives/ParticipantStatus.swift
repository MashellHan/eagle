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
