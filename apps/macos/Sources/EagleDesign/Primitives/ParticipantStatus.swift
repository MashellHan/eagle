public struct ParticipantStatus: Equatable, Sendable {
  public enum Phase: Equatable, Sendable {
    case idle, working, connecting, attention, offline
  }

  public let label: String
  public let phase: Phase
  public let canStop: Bool
  public let canRecover: Bool
  public let error: String?

  public var isActive: Bool { phase == .working || phase == .connecting }

  public init(
    label: String, phase: Phase, canStop: Bool = false,
    canRecover: Bool = false, error: String? = nil
  ) {
    self.label = label
    self.phase = phase
    self.canStop = canStop
    self.canRecover = canRecover
    self.error = error
  }
}
