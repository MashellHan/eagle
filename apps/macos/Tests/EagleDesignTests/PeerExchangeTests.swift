import Testing

@testable import EagleDesign

@Suite("Peer exchange")
struct PeerExchangeTests {
  private let raven = PeerRef(id: "raven", title: "repo-raven", tintIndex: 1)
  private let vps = PeerRef(id: "vps", title: "VPS管家", tintIndex: 2)

  private func exchange(_ messages: [PeerMessage]) -> PeerExchange {
    PeerExchange(id: "x1", participants: [raven, vps], messages: messages)
  }

  @Test("consecutive messages from one bot read as one burst")
  func bursts() {
    let result = exchange([
      PeerMessage(id: "m1", senderId: "raven", text: "a"),
      PeerMessage(id: "m2", senderId: "raven", text: "b"),
      PeerMessage(id: "m3", senderId: "vps", text: "c"),
      PeerMessage(id: "m4", senderId: "raven", text: "d"),
    ]).bursts

    #expect(result.map(\.sender.title) == ["repo-raven", "VPS管家", "repo-raven"])
    #expect(result.map(\.messages.count) == [2, 1, 1])
    #expect(result.first?.id == "m1")
  }

  @Test("an empty exchange has no bursts and says so")
  func empty() {
    let subject = exchange([])
    #expect(subject.bursts.isEmpty)
    #expect(subject.summary == "0 条消息来往：")
  }

  @Test("the summary counts messages, never describes them")
  func summary() {
    #expect(exchange([PeerMessage(id: "m1", senderId: "vps", text: "a")]).summary == "1 条消息来往：")
    #expect(
      exchange((0..<4).map { PeerMessage(id: "m\($0)", senderId: "vps", text: "") }).summary
        == "4 条消息来往：")
  }

  @Test("a sender the exchange does not list keeps its own burst under its id")
  func unknownSender() {
    let result = exchange([PeerMessage(id: "m1", senderId: "ghost", text: "a")]).bursts
    #expect(result.count == 1)
    #expect(result.first?.sender.id == "ghost")
    #expect(result.first?.sender.title == "ghost")
    #expect(result.first?.messages.first?.text == "a")
  }

  @Test("participants answer by id")
  func participants() {
    let subject = exchange([])
    #expect(subject.participant("vps")?.title == "VPS管家")
    #expect(subject.participant("nobody") == nil)
  }
}
