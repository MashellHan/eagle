import BotsCore
import BotsTransport
import XCTest

/// PROTOCOL.md, "usage": the snapshot may carry totals, an event replaces them, and a
/// daemon that reports no cost leaves the field out.
final class UsageFrameTests: XCTestCase {
  func testTheSnapshotCarriesTotalsAndCost() throws {
    let decoded = try Wire.decode(
      Data(
        #"""
        {"type":"snapshot","rev":9,"trace":"tr_1","value":{"botId":"b_1","messages":[],
        "streaming":null,"pending":[],"inbox":[],"running":false,
        "usage":{"inputTokens":1234,"outputTokens":567,"totalTokens":1801,"costUsd":0.42}}}
        """#.utf8))
    guard case .snapshot(let snapshot) = decoded.event else {
      return XCTFail("expected a snapshot")
    }
    XCTAssertEqual(snapshot.usage?.totalTokens, 1801)
    XCTAssertEqual(snapshot.usage?.costUsd ?? 0, 0.42, accuracy: 0.0001)
  }

  func testTheUsageEventReplacesTheTotals() throws {
    let decoded = try Wire.decode(
      Data(
        #"""
        {"type":"usage","rev":10,"trace":"tr_1",
        "usage":{"inputTokens":2000,"outputTokens":800,"totalTokens":2800}}
        """#.utf8))
    guard case .usage(let usage) = decoded.event else {
      return XCTFail("expected a usage event")
    }
    XCTAssertEqual(usage.totalTokens, 2800)
    XCTAssertNil(usage.costUsd, "a gateway without cost reports tokens only")
    XCTAssertEqual(decoded.rev, 10)
  }
}
