import BotsCore
import BotsTransport
import Foundation
import SwiftUI

/// One selected bot: connection, transcript, composer and the error surface. All daemon
/// interaction goes through the ports, so this layer can be tested with fakes
/// (docs/bots/ARCHITECTURE.md, "Layers").
@MainActor
public final class ConversationViewModel: ObservableObject {
  @Published public private(set) var state: ConversationState
  @Published public private(set) var connection: ConnectionState = .connecting
  @Published public private(set) var hasSnapshot = false
  @Published public private(set) var errorBanner: String?
  @Published public private(set) var isSending = false
  @Published public private(set) var hasOlder = false
  @Published public private(set) var historyBranches: [NativeHistoryBranch] = []
  @Published public private(set) var historyView: NativeHistoryView?
  @Published public private(set) var localBranchId: String?
  /// A parked task is recoverable: `recover` retries it.
  @Published public private(set) var parked = false
  private var draftStorage = ""
  public var draft: String {
    get { draftStorage }
    set { updateDraft(newValue) }
  }

  /// Updates draft storage without `ObservableObject` fan-out (the shell mirrors into `composer`).
  public func writeDraft(_ value: String) {
    guard draftStorage != value else { return }
    draftStorage = value
  }

  private let conversation: ConversationPort
  private let history: NativeHistoryPort?
  private let outbox: OutboxStore
  private let now: () -> Date
  private var eventsTask: Task<Void, Never>?
  private var historyTask: Task<Void, Never>?
  private var assessmentTask: Task<Void, Never>?
  private var historyDirty = false
  private var historyGeneration = UUID()
  private var viewGeneration = UUID()
  private var continuationRequests: [String: String] = [:]
  private var displayedBranch: String?
  private var followsReceivedWhenEmpty = true
  private var selectedBotId: String?
  /// The outbox is reconciled after the first snapshot of the selected bot, never after
  /// the handshake: a send before the subscription exists is refused as `not_admitted`.
  private var reconciled = false
  /// Requests the daemon refused. They are never replayed by a reconciliation, even if
  /// their outbox entry could not be removed (the user decides whether to retry).
  private var refused: Set<String> = []
  /// Sends the user asked for that have not been confirmed yet.
  private var inFlight: [String: String] = [:]
  /// The absolute catalog a `bots` frame carries, for the window's sidebar.
  public var onCatalog: ((BotCatalog) -> Void)?

  public init(
    botId: String = "",
    conversation: ConversationPort,
    outbox: OutboxStore,
    history: NativeHistoryPort? = nil,
    now: @escaping () -> Date = { Date() }
  ) {
    self.state = ConversationState(botId: botId)
    self.conversation = conversation
    self.history = history
    self.outbox = outbox
    self.now = now
  }

  public var title: String { selectedBotId ?? "" }
  /// The live work of the selected bot, for the inspector's 任务 section.
  public var tasks: [TaskSummary] { state.tasks }
  /// The bot's own triggers, as the sidebar's trigger section renders them.
  public var triggers: [TriggerSummary] { state.triggers }
  /// The pull requests the bot reported, newest first.
  public var pulls: [PullSummary] { state.pulls }
  /// Tokens and cost so far, for the inspector's 用量 section.
  public var usage: Usage? { state.usage }
  public var canSend: Bool {
    !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && connection == .ready
      && state.unavailable == nil
      && displayedHeadIsCurrent
      && !continuationRequests.values.contains(selectedBotId ?? "")
  }

  private var displayedHeadIsCurrent: Bool {
    guard let displayedBranch else { return historyView == nil }
    return historyView?.branchId == displayedBranch
      && historyBranches.contains {
        $0.branchId == displayedBranch && $0.selection == historyView?.head
      }
  }

  public var displayState: ConversationState {
    guard let historyView else { return state }
    var displayed = state
    displayed.messages = historyView.messages
    displayed.running = false
    return displayed
  }

  public func historyChanged() {
    guard history != nil, hasSnapshot else { return }
    historyDirty = true
    guard historyTask == nil else { return }
    let generation = historyGeneration
    historyTask = Task { [weak self] in
      guard let self else { return }
      while self.historyDirty, self.historyGeneration == generation, !Task.isCancelled {
        self.historyDirty = false
        await self.refreshHistory()
      }
      if self.historyGeneration == generation { self.historyTask = nil }
    }
  }

  public func refreshHistory() async {
    guard let history, let botId = selectedBotId, hasSnapshot else { return }
    do {
      let branches = try await history.branches(botId: botId)
      guard selectedBotId == botId, !Task.isCancelled else { return }
      historyBranches = branches.filter {
        $0.selection.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
      }
      if displayedBranch == nil, followsReceivedWhenEmpty, state.messages.isEmpty, !state.running {
        displayedBranch = historyBranches.first?.branchId
      }
      if let selected = historyBranches.first(where: { $0.branchId == displayedBranch }) {
        await showHistory(selected, botId: botId)
      }
    } catch {
      // Optional history reads leave the live conversation and composer available.
    }
  }

  public func selectHistory(_ branchId: String?) async {
    viewGeneration = UUID()
    followsReceivedWhenEmpty = false
    displayedBranch = branchId
    assessmentTask?.cancel()
    guard let branchId, let branch = historyBranches.first(where: { $0.branchId == branchId }),
      let botId = selectedBotId
    else {
      historyView = nil
      return
    }
    await showHistory(branch, botId: botId)
  }

  private func showHistory(_ branch: NativeHistoryBranch, botId: String) async {
    guard let history else { return }
    let generation = UUID()
    viewGeneration = generation
    do {
      let view = try await history.view(botId: botId, head: branch.selection)
      guard selectedBotId == botId, displayedBranch == branch.branchId,
        viewGeneration == generation, !Task.isCancelled
      else { return }
      historyView = view
      assessmentTask?.cancel()
      assessmentTask = Task { [weak self] in
        guard !Task.isCancelled else { return }
        guard let usable = try? await history.assess(botId: botId, head: view.head),
          !Task.isCancelled, self?.viewGeneration == generation,
          self?.historyView?.head == view.head
        else { return }
        self?.historyView?.usable = usable
      }
    } catch { errorBanner = Self.describe(error) }
  }

  /// Connects to a bot and replaces the transcript with its snapshot. Selecting the same bot
  /// again is a no-op, so a list refresh does not reconnect.
  public func select(botId: String) {
    if selectedBotId == botId, eventsTask != nil { return }
    eventsTask?.cancel()
    historyGeneration = UUID()
    viewGeneration = UUID()
    historyTask?.cancel()
    assessmentTask?.cancel()
    historyTask = nil
    displayedBranch = nil
    historyView = nil
    historyBranches = []
    localBranchId = nil
    followsReceivedWhenEmpty = true
    selectedBotId = botId
    reconciled = false
    hasSnapshot = false
    state = ConversationState(botId: botId)
    applySettledRecords(for: botId)
    if let durable = try? outbox.refusedRequests() {
      refused.formUnion(durable)
    }
    connection = .connecting
    errorBanner = nil
    let stream = conversation.open(botId: botId)
    eventsTask = Task { [weak self] in
      for await event in stream {
        guard let self, !Task.isCancelled else { return }
        self.apply(event)
      }
    }
  }

  /// A connection that ended for good (the daemon is not running): open it again instead
  /// of hoping the socket retries, and keep the transcript that is already on screen.
  public func reconnect() {
    guard let botId = selectedBotId else { return }
    eventsTask?.cancel()
    eventsTask = nil
    select(botId: botId)
  }

  public func disconnect() {
    historyGeneration = UUID()
    viewGeneration = UUID()
    eventsTask?.cancel()
    eventsTask = nil
    historyTask?.cancel()
    historyTask = nil
    assessmentTask?.cancel()
    selectedBotId = nil
    conversation.close()
    connection = .stopped
    hasSnapshot = false
  }

  public func send() {
    send(inserting: false)
  }

  /// `inserting` steers the run that is answering instead of queueing behind it; while the
  /// bot is idle the daemon places it like any other input.
  public func send(inserting: Bool) {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, connection == .ready, let botId = selectedBotId else { return }
    guard displayedHeadIsCurrent else { return }
    guard !continuationRequests.values.contains(botId) else {
      errorBanner = "正在建立本机续聊，请稍候再发送。"
      return
    }
    if let view = historyView {
      guard view.usable, !state.running, !isSending else {
        errorBanner = "此会话尚不可继续，请等待同步完成或本机回答结束。"
        return
      }
      let entry = OutboxEntry(
        botId: botId, requestId: Identifiers.request(), text: text, historyHead: view.head)
      continueHistory(entry, explicit: true)
      return
    }
    let requestId = Identifiers.request()
    draft = ""
    send(text: text, requestId: requestId, botId: botId, optimistic: true, inserting: inserting)
  }

  /// Retrying keeps the original requestId, which is how it is recovered, including after a
  /// restart of the app (`OutboxStore`).
  public func retry(_ entry: OutboxEntry) {
    refused.remove(entry.requestId)
    if entry.historyHead != nil {
      continueHistory(entry, explicit: false)
      return
    }
    send(text: entry.text, requestId: entry.requestId, botId: entry.botId, optimistic: true)
  }

  public func abort() {
    guard let botId = selectedBotId else { return }
    let context = CommandContext.command("abort")
    Task { [weak self] in
      do {
        try await self?.conversation.abort(context: context, botId: botId)
      } catch {
        self?.errorBanner = Self.describe(error)
      }
    }
  }

  public func recover() {
    guard let botId = selectedBotId else { return }
    let context = CommandContext.command("recover")
    Task { [weak self] in
      guard let self else { return }
      do {
        try await self.conversation.recover(context: context, botId: botId)
        // Only a command that reached the daemon clears the parked state: a recover
        // dropped while reconnecting must leave the affordance in place.
        self.parked = false
      } catch {
        self.errorBanner = Self.describe(error)
      }
    }
  }

  public func loadOlder() {
    guard let oldest = state.messages.first(where: { !$0.isOptimistic })?.id,
      let botId = selectedBotId
    else { return }
    let context = CommandContext.command("history")
    Task { [weak self] in
      do {
        try await self?.conversation.loadHistory(before: oldest, context: context, botId: botId)
      } catch {
        self?.errorBanner = Self.describe(error)
      }
    }
  }

  public func dismissError() {
    errorBanner = nil
  }

  private func updateDraft(_ value: String) {
    guard draftStorage != value else { return }
    draftStorage = value
  }

  // MARK: - Sending

  private func continueHistory(_ entry: OutboxEntry, explicit: Bool) {
    guard let history, let head = entry.historyHead else { return }
    do { try outbox.add(entry) } catch {
      errorBanner = "无法保存待发送的消息，消息没有发出。"
      return
    }
    let previousView = historyView
    let previousBranch = displayedBranch
    let generation = viewGeneration
    if explicit {
      draft = ""
      followsReceivedWhenEmpty = false
      displayedBranch = nil
      historyView = nil
      assessmentTask?.cancel()
    }
    isSending = true
    continuationRequests[entry.requestId] = entry.botId
    Task { [weak self] in
      guard let self else { return }
      defer {
        if self.selectedBotId == entry.botId { self.isSending = false }
      }
      do {
        let result = try await history.continueHistory(
          botId: entry.botId, head: head, text: entry.text, requestId: entry.requestId)
        self.continuationRequests.removeValue(forKey: entry.requestId)
        if result.submission.status.isTerminal {
          try self.outbox.settle(result.submission, botId: entry.botId)
        }
        guard self.selectedBotId == entry.botId else { return }
        if explicit { self.localBranchId = result.branchId }
        self.state = Reducer.applySubmission(result.submission, to: self.state)
        if result.submission.status == .unanswered {
          self.errorBanner = "续聊未完成，请保留请求 \(entry.requestId)。"
        }
      } catch {
        if (error as? ClientError)?.disposition == .notAdmitted {
          self.continuationRequests.removeValue(forKey: entry.requestId)
          self.refused.insert(entry.requestId)
          do { try self.outbox.refuse(requestId: entry.requestId) } catch {
            self.errorBanner = "消息被拒绝，本地待发记录暂时没有删掉。"
          }
          if self.selectedBotId == entry.botId {
            self.draft = self.draft.isEmpty ? entry.text : self.draft + "\n\n" + entry.text
            if explicit, self.viewGeneration == generation {
              self.displayedBranch = previousBranch
              self.historyView = previousView
            }
            self.errorBanner = Self.describe(error)
          }
          return
        }
        if self.selectedBotId == entry.botId {
          self.errorBanner = "续聊结果尚未确认，请重试原请求 \(entry.requestId)。\(Self.describe(error))"
        }
      }
    }
  }

  private func send(
    text: String,
    requestId: String,
    botId: String,
    optimistic: Bool,
    inserting: Bool = false
  ) {
    // The entry is stored before the frame is written; if it cannot be stored, nothing is
    // sent and the draft comes back (PROTOCOL.md, client duties 1).
    do {
      try outbox.add(OutboxEntry(botId: botId, requestId: requestId, text: text))
    } catch {
      draft = text
      errorBanner = "无法保存待发送的消息，消息没有发出。"
      return
    }
    isSending = true
    if optimistic {
      state = Reducer.apply(
        .append(message: .optimistic(requestId: requestId, text: text), replaces: nil),
        to: state
      )
    }
    inFlight[requestId] = text
    let context = CommandContext.send(requestId)
    Task { [weak self] in
      guard let self else { return }
      do {
        try await self.conversation.send(
          text,
          whenBusy: inserting ? .steer : .followUp,
          context: context,
          botId: botId
        )
        self.isSending = false
      } catch {
        self.isSending = false
        self.errorBanner = Self.describe(error)
      }
    }
  }

  /// Replays every stored entry with its own requestId; pi answers with the stored record
  /// (PROTOCOL.md, client duties 2).
  private func reconcileOutbox() {
    guard let botId = selectedBotId else { return }
    persistPendingRefusals()
    let durableRefusals: Set<String>
    do {
      durableRefusals = Set(try outbox.refusedRequests())
    } catch {
      errorBanner = "本地待发消息暂时读不出来，稍后重试。"
      reconciled = false
      return
    }
    let entries: [OutboxEntry]
    do {
      entries = try outbox.entries(for: botId)
    } catch {
      // An unreadable outbox is unknown, not empty: report it and try again on the next
      // snapshot instead of pretending there is nothing to send.
      errorBanner = "本地待发消息暂时读不出来，稍后重试。"
      reconciled = false
      return
    }
    for entry in entries
    where !refused.contains(entry.requestId)
      && !durableRefusals.contains(entry.requestId)
    {
      if entry.historyHead != nil {
        continueHistory(entry, explicit: false)
        continue
      }
      send(
        text: entry.text,
        requestId: entry.requestId,
        botId: entry.botId,
        optimistic: !state.messages.contains { $0.requestId == entry.requestId }
      )
    }
  }

  /// Refusals whose durable write failed are retried on the next successful read.
  private func persistPendingRefusals() {
    guard !refused.isEmpty else { return }
    var written: [String] = []
    for requestId in refused {
      do {
        try outbox.refuse(requestId: requestId)
        written.append(requestId)
      } catch {
        return
      }
    }
    // They are durable now; the in-memory set is only a cache of them.
    _ = written
  }

  /// A terminal record stored before the app closed is applied again, so a settlement is
  /// not lost when the snapshot no longer carries it.
  private func applySettledRecords(for botId: String) {
    let stored: [SettledRequest]
    do {
      stored = try outbox.settledRequests()
    } catch {
      errorBanner = "本地结算记录暂时读不出来。"
      return
    }
    for record in stored where record.botId == botId {
      state = Reducer.applySubmission(
        Submission(
          id: record.submissionId,
          requestId: record.requestId,
          status: record.status,
          entryId: record.entryId,
          answerEntryId: record.answerEntryId,
          reason: record.reason
        ),
        to: state
      )
    }
  }

  // MARK: - Events

  private func apply(_ event: ConversationEvent) {
    switch event {
    case .connection(let next):
      if case .ready = next {
        // the first snapshot after any connection reconciles
      } else {
        reconciled = false
        hasSnapshot = false
      }
      connection = next

    case .snapshot(let value):
      state = Reducer.snapshot(value, rev: state.lastRev.map { $0 + 1 }, keeping: state.ranks)
      hasSnapshot = true
      parked = state.parked
      hasOlder = value.truncatedBefore != nil
      for record in value.pending {
        continuationRequests.removeValue(forKey: record.requestId)
      }
      // Every snapshot is a chance to make a refusal durable, even when no reconciliation
      // is due.
      persistPendingRefusals()
      if !reconciled {
        reconciled = true
        reconcileOutbox()
      }
      historyChanged()
    case .append(let message, let replaces):
      state = Reducer.apply(.append(message: message, replaces: replaces), to: state)
    case .delta(let messageId, let changes):
      state = Reducer.apply(.delta(messageId: messageId, changes: changes), to: state)
    case .status(let running, let inbox, let streaming):
      state = Reducer.apply(
        .status(running: running, inbox: inbox, streaming: streaming),
        to: state
      )
    case .submission(let record):
      continuationRequests.removeValue(forKey: record.requestId)
      state = Reducer.apply(.submission(record), to: state)
      if record.status.isTerminal {
        inFlight.removeValue(forKey: record.requestId)
        // The terminal record is stored in the same atomic write that removes the entry
        // (PROTOCOL.md, client duties 2); a placement in a snapshot is not a settlement.
        try? outbox.settle(record, botId: selectedBotId ?? "")
      }
    case .history(let page):
      state = Reducer.apply(.history(page: page), to: state)
      hasOlder = page.hasMore
    case .tasks(let tasks):
      state = Reducer.apply(.tasks(tasks), to: state)
    case .triggers(let triggers):
      state = Reducer.apply(.triggers(triggers), to: state)
    case .pulls(let pulls):
      state = Reducer.apply(.pulls(pulls), to: state)
    case .usage(let usage):
      state = Reducer.apply(.usage(usage), to: state)
    case .agent(let agent):
      state = Reducer.apply(.agent(agent), to: state)
    case .catalog(let catalog):
      onCatalog?(catalog)
    case .error(let kind, let disposition, let message, _, let requestId):
      errorBanner = message
      if kind == .taskParked { parked = true }
      state = applyUnavailable(kind: kind)
      switch disposition {
      case .notAdmitted:
        // The daemon refused before admission: drop the bubble and the entry, and put the
        // text back so the user can fix or retry it (PROTOCOL.md, client duties 3).
        if let requestId {
          let text = inFlight.removeValue(forKey: requestId)
          refused.insert(requestId)
          do {
            try outbox.refuse(requestId: requestId)
          } catch {
            // The store is not writable right now: the refusal stays in memory and is
            // written as soon as a read succeeds again, so the entry is never replayed in
            // the meantime. The failure is shown rather than swallowed.
            errorBanner = "消息被拒绝，本地待发记录暂时没有删掉。"
          }
          state.messages.removeAll { $0.id == "local_\(requestId)" }
          if let text {
            // Neither the refused text nor a newer draft may be lost.
            draft = draft.isEmpty ? text : draft + "\n\n" + text
          }
        }
      case .unknown:
        // Admission could not be confirmed: keep the bubble and the entry for a retry.
        break
      case .runtime:
        break
      }
      if let requestId, state.pending.contains(where: { $0.requestId == requestId }) {
        state.pending.removeAll { $0.requestId == requestId }
      }
    }
  }

  private func applyUnavailable(kind: ErrorKind) -> ConversationState {
    guard kind == .storageFailed || kind == .internalError else { return state }
    var next = state
    next.unavailable = BotUnavailable(reason: kind, message: "the bot is unavailable")
    next.messages = []
    next.pending = []
    next.inbox = []
    next.streaming = nil
    next.running = false
    next.tasks = []
    next.triggers = []
    next.pulls = []
    return next
  }

  private static func describe(_ error: Error) -> String {
    if let client = error as? ClientError { return client.message }
    return error.localizedDescription
  }
}
