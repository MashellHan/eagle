import BotsCore
import BotsTransport
import XCTest

/// PROTOCOL.md, "Live tasks": a snapshot carries the list, a `tasks` event replaces it
/// whole, and a status the daemon adds later must not make the frame unreadable.
final class TaskFrameTests: XCTestCase {
  private func data(_ json: String) -> Data {
    Data(json.utf8)
  }

  func testTheSnapshotCarriesItsLiveTasks() throws {
    let decoded = try Wire.decode(
      data(
        #"""
        {"type":"snapshot","rev":42,"trace":"tr_1","value":{"botId":"b_1","messages":[],
        "streaming":null,"pending":[],"inbox":[],"running":true,"tasks":[
        {"id":"t_12","kind":"pi.generation","status":"running","phase":"generate",
        "background":false,"conversationId":"c_1"},
        {"id":"t_13","kind":"pi.tool","status":"waiting","phase":"run",
        "background":false,"owner":"t_12","conversationId":"c_1"}]}}
        """#
      )
    )
    guard case .snapshot(let snapshot) = decoded.event else {
      return XCTFail("expected a snapshot")
    }
    XCTAssertEqual(snapshot.tasks.map(\.id), ["t_12", "t_13"])
    XCTAssertEqual(snapshot.tasks[0].kind, "pi.generation")
    XCTAssertEqual(snapshot.tasks[0].status, .running)
    XCTAssertEqual(snapshot.tasks[0].phase, "generate")
    XCTAssertEqual(snapshot.tasks[0].background, false)
    XCTAssertEqual(snapshot.tasks[0].conversationId, "c_1")
    XCTAssertNil(snapshot.tasks[0].owner)
    XCTAssertEqual(snapshot.tasks[1].owner, "t_12")
    XCTAssertEqual(decoded.rev, 42)
  }

  func testASnapshotWithoutTasksIsEmptyNotUnknown() throws {
    let decoded = try Wire.decode(
      data(
        #"""
        {"type":"snapshot","rev":7,"trace":"tr_2","value":{"botId":"b_1","messages":[],
        "streaming":null,"pending":[],"inbox":[],"running":false}}
        """#
      )
    )
    guard case .snapshot(let snapshot) = decoded.event else {
      return XCTFail("expected a snapshot")
    }
    XCTAssertEqual(snapshot.tasks, [])
  }

  func testTheTasksEventReplacesTheWholeList() throws {
    let decoded = try Wire.decode(
      data(
        #"""
        {"type":"tasks","rev":45,"trace":"tr_3","tasks":[
        {"id":"t_20","kind":"bots.agents.child","status":"pending","phase":"queue",
        "background":true,"blocked":"restart_limit","conversationId":"c_2"}]}
        """#
      )
    )
    guard case .tasks(let tasks) = decoded.event else {
      return XCTFail("expected a tasks event")
    }
    XCTAssertEqual(decoded.type, "tasks")
    XCTAssertEqual(decoded.rev, 45)
    XCTAssertEqual(tasks.map(\.id), ["t_20"])
    XCTAssertEqual(tasks[0].kind, "bots.agents.child")
    XCTAssertEqual(tasks[0].status, .pending)
    XCTAssertEqual(tasks[0].blocked, "restart_limit")
    XCTAssertEqual(tasks[0].background, true)
  }

  func testAnEmptiedTaskListDecodesToNoTasks() throws {
    let decoded = try Wire.decode(data(#"{"type":"tasks","rev":46,"trace":"tr_4","tasks":[]}"#))
    guard case .tasks(let tasks) = decoded.event else {
      return XCTFail("expected a tasks event")
    }
    XCTAssertEqual(tasks, [])
  }

  func testAStatusTheClientDoesNotKnowDecodesAsItself() throws {
    let decoded = try Wire.decode(
      data(
        #"""
        {"type":"tasks","rev":47,"trace":"tr_5","tasks":[
        {"id":"t_30","kind":"pi.generation","status":"throttled","phase":"generate",
        "background":false,"conversationId":"c_1"}]}
        """#
      )
    )
    guard case .tasks(let tasks) = decoded.event else {
      return XCTFail("expected a tasks event")
    }
    XCTAssertEqual(tasks.count, 1, "an unknown status never fails the frame")
    XCTAssertEqual(tasks[0].status.rawValue, "throttled")
  }

  func testATaskWithoutTheOptionalFieldsStillDecodes() throws {
    let decoded = try Wire.decode(
      data(
        #"""
        {"type":"tasks","rev":48,"trace":"tr_6","tasks":[
        {"id":"t_40","kind":"pi.tool","status":"sleeping"}]}
        """#
      )
    )
    guard case .tasks(let tasks) = decoded.event else {
      return XCTFail("expected a tasks event")
    }
    XCTAssertEqual(tasks[0].phase, nil)
    XCTAssertEqual(tasks[0].background, false)
    XCTAssertEqual(tasks[0].conversationId, nil)
    XCTAssertEqual(tasks[0].status, .sleeping)
  }
}
