import Combine
import EagleDesign
import Foundation

/// State and behaviour of the settings window.
public final class SettingsViewModel: ObservableObject {
  @Published public var selection: SettingsSection = .machines
  @Published public var machines: [MachineDevice]
  @Published public var usage: UsageSummary
  @Published public var launchAtLogin = true
  @Published public var showUnfocusedSpaces = true
  @Published public var followTerminal = true
  @Published public var allowRemoteInput = false
  @Published public var updateState: UpdateState = .current("0.14.1")
  @Published public private(set) var renameTarget: String?

  public init(
    machines: [MachineDevice] = MockSettings.machines,
    usage: UsageSummary = MockSettings.usage
  ) {
    self.machines = machines
    self.usage = usage
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
