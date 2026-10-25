import BotsTransport
import XCTest

/// PROTOCOL.md, "Close codes": which codes stop and which retry.
final class ClosePolicyTests: XCTestCase {
  func testAProtocolViolationNeverReconnects() {
    for code in [1008, 4001, 4004, 4009, 1000] {
      guard case .stop = ConversationSocket.closeBehaviour(code) else {
        return XCTFail("\(code) must stop")
      }
    }
  }

  func testAQuarantinedOrTransientCloseRetries() {
    for code in [4090, 1006, 1011, 4000, 4010] {
      XCTAssertEqual(ConversationSocket.closeBehaviour(code), .retry, "\(code) must retry")
    }
  }
}
