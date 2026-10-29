import SwiftUI

/// One bot at the other end of an exchange, as the transcript draws it. The face travels with the
/// name because the same bot appears in the row, the chip and the origin line.
public struct PeerRef: Identifiable, Hashable, Sendable {
  public let id: String
  public let title: String
  /// The bot's own face; nil falls back to a tinted initial.
  public let face: BotFace.Style?
  public let tintIndex: Int

  public init(id: String, title: String, face: BotFace.Style? = nil, tintIndex: Int = 0) {
    self.id = id
    self.title = title
    self.face = face
    self.tintIndex = tintIndex
  }
}

/// Who an answer was given to, and the exchange it belongs to. The id lets the row open that
/// exchange; an origin without one is a label only.
public struct PeerOrigin: Hashable, Sendable {
  public let peer: PeerRef
  public let exchangeId: String?

  public init(peer: PeerRef, exchangeId: String? = nil) {
    self.peer = peer
    self.exchangeId = exchangeId
  }
}

/// One message inside an exchange. Text is what a person reads: the dialog is not a log viewer.
public struct PeerMessage: Identifiable, Hashable, Sendable {
  public let id: String
  public let senderId: String
  public let text: String

  public init(id: String, senderId: String, text: String) {
    self.id = id
    self.senderId = senderId
    self.text = text
  }
}

/// A run of consecutive messages from one bot. The dialog signs each run once, at its end.
public struct PeerBurst: Identifiable, Hashable, Sendable {
  public let sender: PeerRef
  public let messages: [PeerMessage]

  public init(sender: PeerRef, messages: [PeerMessage]) {
    self.sender = sender
    self.messages = messages
  }

  public var id: String { messages.first?.id ?? sender.id }
}

/// One exchange between the open bot and one counterpart: the whole round trip, not one send.
/// This is view state only; the daemon owns durability and the client reads it as one record.
public struct PeerExchange: Identifiable, Hashable, Sendable {
  public let id: String
  /// Both sides, in the order the daemon recorded them. Two: an exchange is always a pair.
  public let participants: [PeerRef]
  public let messages: [PeerMessage]
  /// When the exchange started, already formatted for the divider.
  public let startedAt: String?

  public init(
    id: String,
    participants: [PeerRef],
    messages: [PeerMessage],
    startedAt: String? = nil
  ) {
    self.id = id
    self.participants = participants
    self.messages = messages
    self.startedAt = startedAt
  }

  /// The collapsed row's first half: a count, never a summary of what was said.
  public var summary: String { "\(messages.count) 条消息来往：" }

  public func participant(_ id: String) -> PeerRef? {
    participants.first { $0.id == id }
  }

  /// Consecutive messages from the same bot read as one turn. A sender the exchange does not list
  /// keeps its own burst under its raw id, so a missing participant never hides a message.
  public var bursts: [PeerBurst] {
    var bursts: [PeerBurst] = []
    var run: [PeerMessage] = []
    for message in messages {
      if let current = run.first, current.senderId != message.senderId {
        bursts.append(burst(senderId: current.senderId, messages: run))
        run = []
      }
      run.append(message)
    }
    if let first = run.first {
      bursts.append(burst(senderId: first.senderId, messages: run))
    }
    return bursts
  }

  private func burst(senderId: String, messages: [PeerMessage]) -> PeerBurst {
    PeerBurst(
      sender: participant(senderId)
        ?? PeerRef(id: senderId, title: senderId, face: nil, tintIndex: 0),
      messages: messages
    )
  }
}
