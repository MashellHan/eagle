import BotsTransport
import XCTest

/// PROTOCOL I2: a gap is repaired by one resync, a second resync after the ten-second
/// deadline, a reconnect after that, and a snapshot at any point resets the wait.
final class ResyncStateTests: XCTestCase {
  func testOneResyncPerGap() {
    var state = ResyncState()
    XCTAssertTrue(state.begin(), "the frame that noticed the gap asks once")
    XCTAssertFalse(state.begin(), "further gapped frames wait for the same resync")
    XCTAssertEqual(state.deadlineFired(), .resend)
    XCTAssertTrue(state.pending, "still waiting after the retry")
    XCTAssertEqual(state.deadlineFired(), .reconnect)
    XCTAssertFalse(state.pending, "a reconnect ends the wait")
  }

  func testASnapshotOpensTheBarrierAndTheDeadlineCannotCloseItAgain() {
    var state = ResyncState()
    XCTAssertTrue(state.begin())
    state.snapshotArrived()
    XCTAssertFalse(state.pending)
    XCTAssertEqual(state.attempts, 0, "the snapshot resets the count")
    XCTAssertEqual(state.deadlineFired(), .none, "a stale deadline is a no-op")
    XCTAssertFalse(state.pending, "and it does not re-close the barrier")

    // The same interleaving one step later: the deadline fired, sent its retry, and the
    // snapshot arrived before the deadline was re-armed.
    XCTAssertTrue(state.begin())
    XCTAssertEqual(state.deadlineFired(), .resend)
    state.snapshotArrived()
    XCTAssertEqual(state.deadlineFired(), .none)
    XCTAssertFalse(state.pending)

    // A new gap after a repaired one starts from zero, so it gets its own two windows.
    XCTAssertTrue(state.begin())
    XCTAssertEqual(state.deadlineFired(), .resend, "not the second attempt of the old gap")
  }
}
