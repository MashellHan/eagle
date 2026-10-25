import BotsCore
import Foundation

/// One bot's WebSocket (docs/bots/PROTOCOL.md, "Transport" and "Handshake"). It owns the
/// frame codec's use, the revision baseline, the gap rule, liveness and the close codes;
/// everything it observes becomes a `ConversationEvent`.
public final class ConversationSocket: NSObject {
  public let botId: String
  public let events: AsyncStream<ConversationEvent>

  private let url: URL
  private let token: String
  private let continuation: AsyncStream<ConversationEvent>.Continuation
  private let lock = NSLock()
  private let configuration: URLSessionConfiguration
  private var session: URLSession?
  private var task: URLSessionWebSocketTask?
  private var receiveTask: Task<Void, Never>?
  private var pingTask: Task<Void, Never>?
  private var writeQueue: [Data] = []
  private var writing = false
  private var closed = false
  private var handshakeDone = false
  private var attempt = 0
  private var gap = RevisionGap()
  private var resyncPending = false
  private var resyncAttempts = 0
  private var resyncDeadline: Task<Void, Never>?

  public init(
    baseURL: URL,
    token: String,
    botId: String,
    configuration: URLSessionConfiguration = .default
  ) {
    self.botId = botId
    self.token = token
    self.url = baseURL.appendingPathComponent("/v1/socket")
    self.configuration = configuration
    var captured: AsyncStream<ConversationEvent>.Continuation!
    self.events = AsyncStream { continuation in
      captured = continuation
    }
    self.continuation = captured
    super.init()
  }

  /// Opens the socket, says hello, and subscribes. Safe to call once.
  public func start() {
    lock.lock()
    guard session == nil, !closed else {
      lock.unlock()
      return
    }
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    self.session = session
    lock.unlock()
    emit(.connection(.connecting))
    openTask(in: session)
  }

  public func close() {
    lock.lock()
    if closed {
      lock.unlock()
      return
    }
    closed = true
    resyncDeadline?.cancel()
    resyncDeadline = nil
    pingTask?.cancel()
    pingTask = nil
    let task = self.task
    self.task = nil
    lock.unlock()
    task?.cancel(with: .normalClosure, reason: nil)
    session?.invalidateAndCancel()
    continuation.yield(.connection(.stopped))
    continuation.finish()
  }

  // MARK: - Commands

  public func send(text: String, requestId: String, whenBusy: BusyMode, trace: String) throws {
    enqueue(try Wire.send(requestId: requestId, text: text, whenBusy: whenBusy, trace: trace))
  }

  public func abort(trace: String) throws {
    enqueue(try Wire.abort(trace: trace))
  }

  public func recover(trace: String) throws {
    enqueue(try Wire.recover(trace: trace))
  }

  public func resync(trace: String) throws {
    enqueue(try Wire.resync(trace: trace))
  }

  public func loadHistory(before: String, limit: Int, trace: String) throws {
    enqueue(try Wire.history(before: before, limit: limit, trace: trace))
  }

  // MARK: - Connection

  private func openTask(in session: URLSession) {
    var request = URLRequest(url: url)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    let task = session.webSocketTask(with: request)
    lock.lock()
    self.task = task
    handshakeDone = false
    self.gap = RevisionGap()
    lock.unlock()
    task.resume()
    receiveLoop(task)
    enqueue(try? Wire.hello())
    startPing(in: session)
  }

  private func startPing(in session: URLSession) {
    lock.lock()
    pingTask?.cancel()
    let generation = attempt
    lock.unlock()
    pingTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 15_000_000_000)
        guard let self else { return }
        self.lock.lock()
        let stillCurrent = !self.closed && self.attempt == generation
        let ready = self.handshakeDone
        self.lock.unlock()
        if !stillCurrent { return }
        if ready { self.enqueue(try? Wire.ping()) }
      }
      _ = session
    }
  }

  private func receiveLoop(_ task: URLSessionWebSocketTask) {
    receiveTask?.cancel()
    receiveTask = Task { [weak self] in
      while let self, !Task.isCancelled {
        do {
          let message = try await task.receive()
          guard case .string(let text) = message else {
            self.disconnect(reason: "the daemon sent a binary frame", code: 1008)
            return
          }
          self.handle(text)
        } catch {
          self.disconnect(reason: "the connection ended", code: 1006)
          return
        }
      }
    }
  }

  private func handle(_ text: String) {
    guard let data = text.data(using: .utf8) else { return }
    let decoded: Wire.Decoded
    do {
      decoded = try Wire.decode(data)
    } catch {
      disconnect(reason: "the daemon sent a frame this client cannot read", code: 1008)
      return
    }
    if decoded.type == "welcome" {
      lock.lock()
      handshakeDone = true
      attempt = 0
      gap.reset(to: nil)
      lock.unlock()
      if let catalog = decoded.catalog {
        continuation.yield(.catalog(catalog))
      }
      continuation.yield(.connection(.ready))
      enqueue(try? Wire.subscribe(botId: botId, trace: Identifiers.trace("sub")))
      return
    }
    if let rev = decoded.rev {
      var accept = false
      var gapped = false
      lock.lock()
      if decoded.event == nil, decoded.catalog == nil {
        // An unknown event consumes its revision; it must not look like a gap (I8).
        _ = self.gap.accept(rev)
      } else if case .snapshot? = decoded.event {
        self.gap.reset(to: rev)
        resyncPending = false
        resyncAttempts = 0
        resyncDeadline?.cancel()
        resyncDeadline = nil
        accept = true
      } else if self.gap.isStale(rev) {
        accept = false
      } else if self.gap.accept(rev) {
        accept = true
      } else {
        gapped = true
        accept = false
      }
      lock.unlock()
      if gapped {
        requestResync()
        return
      }
      guard accept else { return }
    }
    if let catalog = decoded.catalog, decoded.type == "bots" {
      continuation.yield(.catalog(catalog))
    }
    if let event = decoded.event {
      continuation.yield(event)
    }
  }

  /// One resync per gap; a second failure without a snapshot reconnects (PROTOCOL I2).
  private func requestResync() {
    lock.lock()
    if closed {
      lock.unlock()
      return
    }
    if resyncPending {
      resyncAttempts += 1
      let exhausted = resyncAttempts >= 2
      lock.unlock()
      if exhausted { disconnect(reason: "the stream kept losing revisions", code: 1011) }
      return
    }
    resyncPending = true
    lock.unlock()
    enqueue(try? Wire.resync(trace: Identifiers.trace("resync")))
    resyncDeadline?.cancel()
    resyncDeadline = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 10_000_000_000)
      guard let self, !Task.isCancelled else { return }
      self.lock.lock()
      let waiting = self.resyncPending && !self.closed
      self.lock.unlock()
      if waiting { self.requestResync() }
    }
  }

  private func disconnect(reason: String, code: Int) {
    lock.lock()
    if closed {
      lock.unlock()
      return
    }
    let previous = task
    task = nil
    handshakeDone = false
    resyncPending = false
    resyncDeadline?.cancel()
    resyncDeadline = nil
    lock.unlock()
    previous?.cancel(with: .abnormalClosure, reason: nil)
    switch closeBehaviour(code) {
    case .stop(let message):
      fail(message)
    case .retry:
      scheduleReconnect()
    }
  }

  private enum CloseBehaviour {
    case stop(String)
    case retry
  }

  /// Close codes are the contract's reconnection policy (PROTOCOL.md, "Close codes").
  private func closeBehaviour(_ code: Int) -> CloseBehaviour {
    switch code {
    case 1008: return .stop("the daemon refused the protocol exchange")
    case 4001: return .stop("the daemon rejected the token")
    case 4004: return .stop("this bot no longer exists")
    case 4009: return .stop("the daemon speaks another protocol version")
    case 4090: return .stop("the bot is quarantined; use recover once it closes")
    case 1000: return .stop("the connection was closed")
    default: return .retry
    }
  }

  private func scheduleReconnect() {
    lock.lock()
    if closed {
      lock.unlock()
      return
    }
    attempt += 1
    let current = attempt
    let session = self.session
    lock.unlock()
    continuation.yield(.connection(.reconnecting(attempt: current)))
    guard let session else { return }
    let delay = min(5.0, 0.4 * pow(2.0, Double(current - 1)))
    Task { [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
      guard let self else { return }
      self.lock.lock()
      let reconnect = !self.closed && self.attempt == current
      self.lock.unlock()
      if reconnect { self.openTask(in: session) }
    }
  }

  private func fail(_ reason: String) {
    lock.lock()
    if closed {
      lock.unlock()
      return
    }
    closed = true
    resyncDeadline?.cancel()
    pingTask?.cancel()
    pingTask = nil
    let task = self.task
    self.task = nil
    lock.unlock()
    task?.cancel(with: .normalClosure, reason: nil)
    session?.invalidateAndCancel()
    continuation.yield(.connection(.failed(reason: reason)))
    continuation.finish()
  }

  private func emit(_ event: ConversationEvent) {
    continuation.yield(event)
  }

  // MARK: - Writes

  private func enqueue(_ data: Data?) {
    guard let data else { return }
    lock.lock()
    if closed {
      lock.unlock()
      return
    }
    writeQueue.append(data)
    let shouldStart = !writing
    writing = true
    lock.unlock()
    if shouldStart { Task { await drain() } }
  }

  private func drain() async {
    while true {
      lock.lock()
      if writeQueue.isEmpty {
        writing = false
        lock.unlock()
        return
      }
      let next = writeQueue.removeFirst()
      let task = self.task
      lock.unlock()
      guard let task else { continue }
      do {
        try await task.send(.string(String(decoding: next, as: UTF8.self)))
      } catch {
        disconnect(reason: "the write failed", code: 1006)
        return
      }
    }
  }
}

extension ConversationSocket: URLSessionWebSocketDelegate {
  public func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) {
    disconnect(reason: "the daemon closed the connection", code: closeCode.rawValue)
  }

  public func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didOpenWithProtocol protocol: String?
  ) {
    lock.lock()
    let current = !closed && handshakeDone == false
    lock.unlock()
    if current { emit(.connection(.connecting)) }
  }
}

/// The `ConversationPort` implementation the view models use: one socket per selected bot.
public final class BotsConnection: ConversationPort {
  private let baseURL: URL
  private let token: String
  private var socket: ConversationSocket?

  public init(baseURL: URL, token: String) {
    self.baseURL = baseURL
    self.token = token
  }

  public func open(botId: String) -> AsyncStream<ConversationEvent> {
    socket?.close()
    let created = ConversationSocket(baseURL: baseURL, token: token, botId: botId)
    socket = created
    created.start()
    return created.events
  }

  public func send(_ text: String, whenBusy: BusyMode, context: CommandContext) async throws {
    guard let socket, let requestId = context.requestId else {
      throw ClientError("there is no connection to send on")
    }
    try socket.send(
      text: text,
      requestId: requestId,
      whenBusy: whenBusy,
      trace: context.trace
    )
  }

  public func abort(context: CommandContext) async throws {
    try require().abort(trace: context.trace)
  }

  public func recover(context: CommandContext) async throws {
    try require().recover(trace: context.trace)
  }

  public func resync(context: CommandContext) async throws {
    try require().resync(trace: context.trace)
  }

  public func loadHistory(before messageId: String, context: CommandContext) async throws {
    try require().loadHistory(before: messageId, limit: 50, trace: context.trace)
  }

  public func close() {
    socket?.close()
    socket = nil
  }

  private func require() throws -> ConversationSocket {
    guard let socket else { throw ClientError("there is no connection") }
    return socket
  }
}
