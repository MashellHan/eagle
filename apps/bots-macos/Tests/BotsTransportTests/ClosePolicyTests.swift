import BotsCore
import BotsTransport
import Foundation
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

/// A command issued while the socket is reconnecting must be refused, not silently
/// dropped: the view model treats a returned command as delivered (R6-3).
final class NotReadyCommandTests: XCTestCase {
  func testCommandsAreRefusedUntilTheHandshakeCompletes() async {
    let connection = BotsConnection(
      baseURL: URL(string: "http://127.0.0.1:9")!,
      token: "test-token-0123456789"
    )
    _ = connection.open(botId: "b_1")
    let context = CommandContext.command("abort")
    do {
      try await connection.abort(context: context, botId: "b_1")
      XCTFail("abort must not be accepted before the handshake")
    } catch {
      XCTAssertTrue(error is ClientError)
    }
    do {
      try await connection.send(
        "hi",
        whenBusy: .followUp,
        context: CommandContext.send("r_notready_1"),
        botId: "b_1"
      )
      XCTFail("send must not be accepted before the handshake")
    } catch {
      XCTAssertTrue(error is ClientError)
    }
    connection.close()
  }
}

/// A first connection that never reached `welcome` is a prompt, not a retry loop; a drop
/// after a live session keeps the contract's retry.
final class NetworkDropPolicyTests: XCTestCase {
  func testNeverReadyIsNotRetried() {
    XCTAssertEqual(
      ConversationSocket.behaviour(code: 1006, everReady: false),
      .stop(ConversationSocket.daemonDownMessage)
    )
  }

  func testAnEstablishedSessionStillRetries() {
    XCTAssertEqual(ConversationSocket.behaviour(code: 1006, everReady: true), .retry)
  }

  func testOtherCodesKeepTheirDocumentedPolicy() {
    XCTAssertEqual(
      ConversationSocket.behaviour(code: 4004, everReady: false),
      .stop("this bot no longer exists"))
    XCTAssertEqual(ConversationSocket.behaviour(code: 4000, everReady: false), .retry)
  }
}
