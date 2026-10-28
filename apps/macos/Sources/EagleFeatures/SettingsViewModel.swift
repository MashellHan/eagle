import BotsCore
import BotsTransport
import Combine
import EagleDesign
import Foundation

extension Notification.Name {
  /// The stored gateway settings changed: the Bots surface re-reads them before send.
  static let botsGatewayChanged = Notification.Name("eagle.bots.gatewayChanged")
}

/// State and behaviour of the settings window.
@MainActor
public final class SettingsViewModel: ObservableObject {
  @Published public var selection: SettingsSection = .bots
  @Published public var machines: [MachineDevice]
  @Published public var usage: UsageSummary
  /// Third-party providers (search today), loaded when the 服务 tab opens.
  @Published public var providers: [ProviderSettings] = []
  @Published public var providerKeys: [String: String] = [:]
  @Published public var providerBusy = false
  @Published public var providerProbe: [String: ProviderProbe] = [:]
  @Published public var providerMessage: String?
  /// The daemon's usage statistics; nil until the 用量与账单 tab is opened.
  @Published public var usageReport: UsageReport?
  @Published public var usageBusy = false
  @Published public var launchAtLogin = true
  @Published public var showUnfocusedSpaces = true
  @Published public var followTerminal = true
  @Published public var allowRemoteInput = false
  @Published public var updateState: UpdateState = .current("0.14.1")
  @Published public private(set) var renameTarget: String?
  /// The model gateway tab: values are loaded only when that tab is opened.
  @Published public var gateway: GatewaySettings?
  @Published public var gatewayBaseURL = ""
  @Published public var gatewayModel = ""
  @Published public var gatewayAPIKey = ""
  @Published public var gatewayThinkingLevel = SettingsViewModel.defaultThinkingLevel
  @Published public var gatewayToolGroups = SettingsViewModel.defaultToolGroups
  @Published public var gatewayProbe: GatewayProbe?
  @Published public var gatewayBusy = false
  @Published public var gatewayMessage: String?
  /// The daemon's reasoning levels, in increasing effort, as the menu lists them.
  public let thinkingLevels: [(value: String, label: String)] = [
    ("off", "关闭"), ("minimal", "极低"), ("low", "低"), ("medium", "中"),
    ("high", "高"), ("xhigh", "极高"), ("max", "最高"),
  ]
  public static let defaultThinkingLevel = "medium"
  /// Every group the daemon knows, in display order; the daemon owns which are installed.
  public static let toolGroups = ["core", "coding", "herdr", "agents", "search"]
  /// What a daemon that predates a new group is assumed to run: new groups stay off.
  public static let defaultToolGroups = ["core", "coding", "herdr", "agents"]
  public static let mandatoryToolGroups: Set<String> = ["core", "coding"]
  public static let herdrToolGroup = "herdr"
  public static let agentsToolGroup = "agents"
  public static let searchToolGroup = "search"
  private var gatewayThinkingLevelChosen = false
  private var gatewayToolGroupsChosen = false
  private var gatewayLoaded = false
  private let botsSettings: BotsSettings
  private let urlSession: URLSession

  public init(
    machines: [MachineDevice] = MockSettings.machines,
    usage: UsageSummary = MockSettings.usage,
    botsSettings: BotsSettings = BotsSettings(),
    urlSession: URLSession = .shared
  ) {
    self.machines = machines
    self.usage = usage
    self.botsSettings = botsSettings
    self.urlSession = urlSession
  }

  public var onlineCount: Int {
    machines.filter(\.online).count
  }

  public func cyclePermission(_ id: String) {
    guard let index = machines.firstIndex(where: { $0.id == id }) else { return }
    machines[index].permission = machines[index].permission.next
  }

  public func setPermission(_ id: String, _ permission: MachinePermission) {
    guard let index = machines.firstIndex(where: { $0.id == id }) else { return }
    machines[index].permission = permission
  }

  public func remove(_ id: String) {
    machines.removeAll { $0.id == id }
  }

  public func beginRename(_ id: String) {
    renameTarget = id
  }

  public func cancelRename() {
    renameTarget = nil
  }

  public func rename(_ id: String, to name: String) {
    defer { renameTarget = nil }
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, let index = machines.firstIndex(where: { $0.id == id }) else { return }
    machines[index].name = trimmed
  }

  /// Reads the daemon's gateway settings once, when the Bots tab is first opened.
  public func loadGatewayIfNeeded() async {
    guard !gatewayLoaded else { return }
    await loadGateway()
  }

  public func loadGateway() async {
    gatewayBusy = true
    defer { gatewayBusy = false }
    do {
      let settings = try await client().loadGateway()
      gateway = settings
      gatewayLoaded = true
      if gatewayBaseURL.isEmpty { gatewayBaseURL = settings.baseUrl }
      if gatewayModel.isEmpty { gatewayModel = settings.model }
      if !gatewayThinkingLevelChosen { gatewayThinkingLevel = settings.thinkingLevel }
      if !gatewayToolGroupsChosen {
        gatewayToolGroups = Self.normalizeToolGroups(settings.toolGroups)
      }
      gatewayMessage = settings.configured ? "已配置" : "尚未配置"
    } catch {
      gatewayMessage = "无法读取 Bots 设置：\(error.localizedDescription)"
    }
  }

  /// The chosen level as the menu shows it; an unknown value falls back to the default's label.
  public var gatewayThinkingLevelLabel: String {
    (thinkingLevels.first { $0.value == gatewayThinkingLevel }
      ?? thinkingLevels.first { $0.value == Self.defaultThinkingLevel })?.label
      ?? Self.defaultThinkingLevel
  }

  /// A pick is a draft until saved; loading must not overwrite it with the stored level.
  public func setGatewayThinkingLevel(_ value: String) {
    gatewayThinkingLevelChosen = true
    gatewayThinkingLevel = value
  }

  public func isToolGroupEnabled(_ name: String) -> Bool {
    gatewayToolGroups.contains(name)
  }

  public func setToolGroup(_ name: String, isOn: Bool) {
    guard !Self.mandatoryToolGroups.contains(name) else { return }
    gatewayToolGroupsChosen = true
    var chosen = Set(gatewayToolGroups)
    if isOn { chosen.insert(name) } else { chosen.remove(name) }
    gatewayToolGroups = Self.normalizeToolGroups(Array(chosen))
  }

  /// Probes the typed values; an empty key field tests the one already stored.
  public func testGateway() async {
    gatewayBusy = true
    gatewayProbe = nil
    defer { gatewayBusy = false }
    do {
      gatewayProbe = try await client().testGateway(
        baseURL: gatewayBaseURL.trimmingCharacters(in: .whitespacesAndNewlines),
        model: gatewayModel.trimmingCharacters(in: .whitespacesAndNewlines),
        apiKey: gatewayAPIKey
      )
    } catch {
      gatewayMessage = error.localizedDescription
    }
  }

  public func saveGateway() async {
    gatewayBusy = true
    defer { gatewayBusy = false }
    do {
      let settings = try await client().saveGateway(
        baseURL: gatewayBaseURL.trimmingCharacters(in: .whitespacesAndNewlines),
        model: gatewayModel.trimmingCharacters(in: .whitespacesAndNewlines),
        thinkingLevel: gatewayThinkingLevel.trimmingCharacters(in: .whitespacesAndNewlines),
        toolGroups: resolvedToolGroups,
        apiKey: gatewayAPIKey
      )
      gateway = settings
      gatewayLoaded = true
      gatewayAPIKey = ""
      gatewayProbe = nil
      gatewayMessage = "已保存，Bot 会使用这个网关"
      NotificationCenter.default.post(name: .botsGatewayChanged, object: nil)
    } catch {
      gatewayMessage = (error as? ClientError)?.message ?? error.localizedDescription
    }
  }

  private var resolvedToolGroups: [String] {
    Self.normalizeToolGroups(gatewayToolGroups)
  }

  private static func normalizeToolGroups(_ groups: [String]) -> [String] {
    let chosen = Set(groups).union(mandatoryToolGroups)
    return toolGroups.filter { chosen.contains($0) }
  }

  private func client() throws -> CatalogHTTPClient {
    let token = try TokenStore(root: botsSettings.rootURL).read()
    return CatalogHTTPClient(baseURL: botsSettings.baseURL, token: token, session: urlSession)
  }

  // MARK: - Providers

  public func loadProviders() async {
    guard !providerBusy else { return }
    providerBusy = true
    defer { providerBusy = false }
    do {
      providers = try await client().loadProviders()
      providerMessage = nil
    } catch {
      providerMessage = (error as? ClientError)?.message ?? error.localizedDescription
    }
  }

  /// A typed key is a draft: an empty field keeps the stored one.
  public func saveProvider(_ id: String) async {
    guard !providerBusy else { return }
    providerBusy = true
    providerMessage = nil
    defer { providerBusy = false }
    let typed = providerKeys[id]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    do {
      let saved = try await client().saveProvider(
        id: id, apiKey: typed.isEmpty ? nil : typed, enabled: nil)
      providers = providers.map { $0.id == id ? saved : $0 }
      if providerKeys[id]?.trimmingCharacters(in: .whitespacesAndNewlines) == typed {
        providerKeys[id] = ""
      }
      providerProbe[id] = nil
      providerMessage = "已保存"
    } catch {
      providerMessage = (error as? ClientError)?.message ?? error.localizedDescription
    }
  }

  public var selectedSearchProvider: ProviderSettings? {
    let selected = providers.filter { $0.enabled && $0.hasApiKey }
    return selected.count == 1 ? selected.first : nil
  }

  public func setProviderEnabled(_ id: String, _ enabled: Bool) async {
    guard !providerBusy else { return }
    guard let index = providers.firstIndex(where: { $0.id == id }) else { return }
    if enabled && !providers[index].hasApiKey {
      providerMessage = "请先保存这个服务商的 API Key"
      return
    }
    guard enabled ? selectedSearchProvider?.id != id : providers[index].enabled else { return }
    providerBusy = true
    defer { providerBusy = false }
    do {
      let saved = try await client().saveProvider(id: id, apiKey: nil, enabled: enabled)
      providers = providers.map { provider in
        if provider.id == id { return saved }
        var other = provider
        if saved.enabled { other.enabled = false }
        return other
      }
      providerMessage = nil
    } catch {
      providerMessage = (error as? ClientError)?.message ?? error.localizedDescription
    }
  }

  public func testProvider(_ id: String) async {
    guard !providerBusy else { return }
    providerBusy = true
    providerMessage = nil
    providerProbe[id] = nil
    defer { providerBusy = false }
    do {
      providerProbe[id] = try await client().testProvider(id: id)
    } catch {
      providerMessage = (error as? ClientError)?.message ?? error.localizedDescription
    }
  }

  /// The 消耗最多 card: a bot that only searched has calls and no tokens.
  public var usageBotRows: [(id: String, title: String, detail: String, value: String)] {
    guard let report = usageReport else { return [] }
    return report.bots.prefix(5).map { bot in
      (
        bot.botId, bot.title, "",
        Self.usageLine(tokens: bot.totalTokens, calls: bot.calls, costUsd: bot.costUsd)
      )
    }
  }

  /// The 用量与账单 sources card: models spend tokens, search spends calls.
  public var usageSourceRows: [(id: String, title: String, value: String)] {
    guard let report = usageReport, let sources = report.sources else { return [] }
    return sources.map { source in
      let title =
        switch source.source {
        case "model": "模型"
        case "search": "搜索"
        default: source.source
        }
      return (
        source.source, title,
        Self.usageLine(tokens: source.totalTokens, calls: source.calls, costUsd: source.costUsd)
      )
    }
  }

  /// One spend in words: tokens, calls and money, with the zero parts left out.
  private static func usageLine(tokens: Int, calls: Int?, costUsd: Double) -> String {
    var parts: [String] = []
    if tokens > 0 { parts.append(UsageFormat.tokens(tokens)) }
    if let calls, calls > 0 { parts.append("\(calls) 次") }
    if let cost = UsageFormat.cost(costUsd), cost != "$0" { parts.append(cost) }
    return parts.isEmpty ? "—" : parts.joined(separator: " · ")
  }

  /// One read per visit; the daemon aggregates 90 days and answers the requested window.
  public func loadUsage(days: Int = 30) async {
    guard !usageBusy else { return }
    usageBusy = true
    defer { usageBusy = false }
    do {
      usageReport = try await client().loadUsage(days: days)
    } catch {
      usageReport = nil
    }
  }

  /// The three headline numbers, already formatted for the settings rows.
  public var usageSummaryRows: [(id: String, title: String, detail: String, value: String)] {
    guard let report = usageReport else { return [] }
    func line(_ totals: UsageReport.Totals) -> String {
      Self.usageLine(tokens: totals.totalTokens, calls: totals.calls, costUsd: totals.costUsd)
    }
    return [
      ("today", "今日", "所有 Bot 的 token、调用与花费", line(report.today)),
      ("week", "近 7 天", "滚动 7 天", line(report.week)),
      ("month", "近 30 天", "滚动 30 天", line(report.month)),
    ]
  }

  public func checkForUpdates() {
    updateState = .checking
    updateState = .current("0.14.1")
  }
}

/// Rows of the account popover and the plan summary it shows.
public final class AccountMenuViewModel: ObservableObject {
  @Published public var planName: String
  @Published public var percentUsed: Int
  @Published public var userName: String

  public init(
    planName: String = "Pro",
    percentUsed: Int = 73,
    userName: String = "Zheng Li"
  ) {
    self.planName = planName
    self.percentUsed = percentUsed
    self.userName = userName
  }

  public var rows: [AccountMenuRow] {
    [
      AccountMenuRow(
        id: "plan",
        systemName: "gauge.with.dots.needle.33percent",
        title: planName,
        detail: "\(percentUsed)% 已用",
        showsChevron: true,
        kind: .plan
      ),
      AccountMenuRow(id: "mobile", systemName: "iphone", title: "获取移动版 Eagle"),
      AccountMenuRow(
        id: "support", systemName: "book", title: "支持", showsChevron: true),
      AccountMenuRow(id: "settings", systemName: "gearshape", title: "设置"),
      AccountMenuRow(
        id: "add", systemName: "person.badge.plus", title: "添加账户", separatorBefore: true),
      AccountMenuRow(
        id: "signout", systemName: "rectangle.portrait.and.arrow.right", title: "退出登录",
        destructive: true),
    ]
  }
}
