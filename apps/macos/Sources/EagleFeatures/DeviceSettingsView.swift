import AppKit
import EagleDesign
import SwiftUI

/// The App's trusted management surface; Bots receive only the shared execution port.
public struct DeviceSettingsView: View {
  @ObservedObject private var model: DeviceSettingsViewModel
  @State private var pairingCode = ""
  @State private var ttlSeconds = 3600
  @State private var removing: DeviceDirectoryEntry?

  public init(model: DeviceSettingsViewModel = .shared) {
    self.model = model
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      serviceCard
      directoryCard
    }
    .task { await model.observe() }
    .alert(
      "移出设备群？",
      isPresented: Binding(
        get: { removing != nil }, set: { if !$0 { removing = nil } }
      )
    ) {
      Button("取消", role: .cancel) { removing = nil }
      Button("移出", role: .destructive) {
        guard let device = removing else { return }
        removing = nil
        Task { await model.removeMember(device.deviceId) }
      }
    } message: {
      Text("移出后，\(removing?.name ?? "此设备") 与群内其他设备不能再互相执行操作。可以通过新配对码重新加入。")
    }
  }

  private var serviceCard: some View {
    SettingsCard {
      VStack(alignment: .leading, spacing: 12) {
        SettingsRow("设备服务") {
          if model.isStarting { SpinnerArc(size: 12) }
          Toggle(
            "启用设备服务",
            isOn: Binding(
              get: { model.enabled }, set: { value in Task { await model.setEnabled(value) } }
            )
          )
          .labelsHidden()
          .toggleStyle(.switch)
          .tint(Theme.Palette.accentStrong)
          .disabled(!model.canToggleService)
        }
        HStack(spacing: 18) {
          Label(model.localReady ? "本机可用" : "本机未就绪", systemImage: "desktopcomputer")
            .foregroundStyle(
              model.localReady ? Theme.Palette.accentStrong : Theme.Palette.textMuted)
          Label(cloudLabel, systemImage: "network")
            .foregroundStyle(Theme.Palette.textSecondary)
          Spacer(minLength: 0)
          SettingsActionButton("刷新") {
            Task {
              await model.startIfNeeded()
              await model.refresh()
            }
          }
          .disabled(!model.enabled || model.controlsBusy)
        }
        .font(Theme.TypeScale.note)
        Text(
          model.enabled
            ? "关闭窗口后服务仍在后台运行。"
            : "启用后可执行本机工具，并与其他设备配对。"
        )
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
        serviceRecovery
        if model.localReady && model.enabled {
          Divider().overlay(Theme.Palette.line)
          if model.pendingRedeemRequestId != nil {
            SettingsCaption("配对待确认")
            pairingContent
          } else {
            DisclosureGroup("添加设备") {
              pairingContent.padding(.top, 12)
            }
            .disclosureGroupStyle(DeviceDisclosureStyle())
            .font(Theme.TypeScale.note)
            .foregroundStyle(Theme.Palette.textPrimary)
          }
        }
      }
      .padding(.bottom, 16)
    }
  }

  @ViewBuilder private var serviceRecovery: some View {
    if let message = model.errorMessage {
      Label(message, systemImage: "exclamationmark.triangle")
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.destructive)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("devices.error")
      if model.needsBackgroundApproval {
        HStack {
          SettingsActionButton("打开系统设置") { model.openSystemSettings() }
          SettingsActionButton("已允许，重试") { Task { await model.startIfNeeded() } }
            .disabled(model.controlsBusy)
        }
      }
    }
    if model.canRetryService {
      SettingsActionButton("重启设备服务") { Task { await model.retryService() } }
        .disabled(model.controlsBusy)
    }
  }

  private var cloudLabel: String {
    guard model.enabled else { return "云端未连接" }
    switch model.cloudStatus {
    case "online": return "云端已连接"
    case "connecting": return "正在连接云端"
    case "offline": return "云端离线"
    default: return "云端状态未知"
    }
  }

  private var policyMenu: some View {
    Menu {
      ForEach(DevicePolicyState.Mode.allCases, id: \.self) { mode in
        Button(mode.title) { Task { await model.setPolicy(mode) } }
      }
    } label: {
      HStack(spacing: 6) {
        Text(model.policy?.mode.title ?? "策略未知")
        Image(systemName: "chevron.down")
      }
      .font(Theme.TypeScale.note)
      .foregroundStyle(Theme.Palette.textPrimary)
    }
    .menuStyle(.borderlessButton)
    .menuIndicator(.hidden)
    .fixedSize()
    .disabled(!model.enabled || !model.localReady || model.controlsBusy || model.policy == nil)
    .accessibilityLabel("本机执行策略")
    .help(policyDetail)
  }

  private var policyDetail: String {
    switch model.policy?.mode {
    case .allApprove:
      "始终允许：设备群内所有 Bot 都可执行此用户有权访问的文件和命令，无需逐个授权。"
    case .alwaysAsk:
      "每次询问：由发起操作的 Mac 上的 Eagle 确认完整操作。App 未运行、未确认或确认过期时，操作被拒绝。"
    case .paused:
      "已暂停接纳新操作。正在执行的操作仍可查询或取消；暂停不会证明工具已停止。"
    default:
      "尚未读到本机策略，请刷新后再试。"
    }
  }

  private var pairingContent: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("在任意一台设备输入另一台的配对码，即可共享整个设备群。")
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textSecondary)
      if let invitation = model.invitation {
        TimelineView(.periodic(from: .now, by: 1)) { context in
          let expiry = Date(timeIntervalSince1970: Double(invitation.expiresAt) / 1000)
          VStack(alignment: .leading, spacing: 10) {
            Text(invitation.code)
              .font(Theme.TypeScale.mono)
              .foregroundStyle(Theme.Palette.textPrimary)
              .textSelection(.enabled)
              .accessibilityLabel("本机配对码")
            HStack {
              Text(
                context.date < expiry
                  ? "有效至 \(expiry.formatted(date: .omitted, time: .shortened)) · 仅可使用一次"
                  : "配对码已过期"
              )
              .font(Theme.TypeScale.note)
              .foregroundStyle(Theme.Palette.textMuted)
              Spacer(minLength: 0)
              SettingsActionButton("复制") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(invitation.code, forType: .string)
              }
              .disabled(context.date >= expiry)
              SettingsActionButton("作废") { Task { await model.revokePairing() } }
                .disabled(model.controlsBusy)
            }
          }
        }
      } else {
        HStack(spacing: 12) {
          Picker("有效期", selection: $ttlSeconds) {
            Text("1 小时").tag(3600)
            Text("24 小时").tag(86400)
          }
          .frame(width: 160)
          SettingsActionButton("生成本机配对码") {
            Task { await model.createPairing(ttlSeconds: ttlSeconds) }
          }
          .disabled(model.controlsBusy)
          Spacer(minLength: 0)
        }
      }
      Divider().overlay(Theme.Palette.line)
      if let requestId = model.pendingRedeemRequestId {
        Text("上次配对尚未确认，请先查询原请求。不会自动重复兑换。")
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.textSecondary)
        DisclosureGroup("配对请求详情") {
          Text(requestId)
            .font(Theme.TypeScale.mono)
            .textSelection(.enabled)
        }
        .disclosureGroupStyle(DeviceDisclosureStyle())
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textMuted)
        SettingsActionButton("查询配对结果", prominent: true) {
          Task { await model.recoverPairing() }
        }
        .disabled(model.controlsBusy)
        HStack(spacing: 10) {
          SettingsTextField("重新输入原配对码", text: $pairingCode)
            .accessibilityLabel("原请求的配对码")
            .onSubmit { redeem() }
          SettingsActionButton("用原请求重试", action: redeem)
            .disabled(
              model.controlsBusy
                || pairingCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      } else {
        HStack(spacing: 10) {
          SettingsTextField("输入另一台设备的配对码", text: $pairingCode)
            .accessibilityLabel("另一台设备的配对码")
            .onSubmit { redeem() }
          SettingsActionButton("配对", prominent: !pairingCode.isEmpty, action: redeem)
            .disabled(
              model.controlsBusy
                || pairingCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }
    }
  }

  private func redeem() {
    guard !model.controlsBusy else { return }
    let code = pairingCode
    pairingCode = ""
    Task { await model.redeem(code: code) }
  }

  private var hasLocalDirectoryEntry: Bool {
    guard let directory = model.directory else { return false }
    return directory.devices.contains { $0.deviceId == directory.localDeviceId }
  }

  private var localDevicePlaceholder: some View {
    HStack(alignment: .top, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: "desktopcomputer")
          .font(.system(size: 16))
          .foregroundStyle(Theme.Palette.textMuted)
          .frame(width: 20)
        VStack(alignment: .leading, spacing: 5) {
          HStack(spacing: 6) {
            Text(Host.current().localizedName ?? ProcessInfo.processInfo.hostName)
              .foregroundStyle(Theme.Palette.textPrimary)
            Text("本机").foregroundStyle(Theme.Palette.textMuted)
          }
          .font(Theme.TypeScale.note)
          .lineLimit(1)
          Text(
            !model.enabled
              ? "设备服务已关闭"
              : model.isStarting
                ? "正在启动"
                : model.localReady ? "本机可用" : "本机未就绪"
          )
          .font(Theme.TypeScale.pill)
          .foregroundStyle(Theme.Palette.textSecondary)
        }
        Spacer(minLength: 0)
      }
      .accessibilityElement(children: .combine)
      policyMenu
    }
    .padding(.vertical, 14)
  }

  private var directoryCard: some View {
    VStack(alignment: .leading, spacing: 12) {
      SettingsCaption("我的设备")
      if model.directory != nil && model.directoryIsStale {
        SettingsCaption("以下为上次读取的目录，当前状态尚未确认。")
      }
      SettingsCard {
        VStack(spacing: 0) {
          if !hasLocalDirectoryEntry {
            localDevicePlaceholder
            if let directory = model.directory, !directory.devices.isEmpty {
              Divider().overlay(Theme.Palette.line)
            }
          }
          if let directory = model.directory {
            ForEach(directory.devices) { device in
              HStack(alignment: .top, spacing: 12) {
                DeviceSummaryView(
                  device: device, isLocal: device.deviceId == directory.localDeviceId,
                  localReady: model.localReady, stale: model.directoryIsStale,
                  showsPolicy: device.deviceId != directory.localDeviceId,
                  serviceEnabled: model.enabled)
                VStack(alignment: .trailing, spacing: 10) {
                  if device.deviceId == directory.localDeviceId {
                    policyMenu
                  }
                  if directory.groupId != nil {
                    SettingsActionButton(device.deviceId == directory.localDeviceId ? "退出群" : "移出")
                    {
                      removing = device
                    }
                    .disabled(
                      !model.enabled || !model.localReady || model.controlsBusy
                        || model.directoryIsStale)
                  }
                }
              }
              .padding(.vertical, 14)
              if device.id != directory.devices.last?.id { Divider().overlay(Theme.Palette.line) }
            }
          }
        }
      }
    }
  }
}

/// The same observed identity appears in settings and every Bot's inspector.
struct DeviceSummaryView: View {
  let device: DeviceDirectoryEntry
  let isLocal: Bool
  let localReady: Bool
  let stale: Bool
  var compact = false
  var showsPolicy = true
  var serviceEnabled = true

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "desktopcomputer")
        .font(.system(size: 16))
        .foregroundStyle(Theme.Palette.textMuted)
        .frame(width: 20)
      VStack(alignment: .leading, spacing: 5) {
        HStack(spacing: 6) {
          Text(device.name).foregroundStyle(Theme.Palette.textPrimary)
          if isLocal { Text("本机").foregroundStyle(Theme.Palette.textMuted) }
        }
        .font(Theme.TypeScale.note)
        .lineLimit(1)
        Text(statusLabel)
          .font(Theme.TypeScale.pill)
          .foregroundStyle(Theme.Palette.textSecondary)
        if showsPolicy {
          Text(device.policy?.mode.title ?? "策略未知")
            .font(Theme.TypeScale.pill)
            .foregroundStyle(Theme.Palette.textMuted)
        }
        if !compact {
          DisclosureGroup("设备详情") {
            VStack(alignment: .leading, spacing: 6) {
              Text(device.deviceId)
                .font(Theme.TypeScale.mono)
                .textSelection(.enabled)
              Text("系统：\(device.platform) · \(device.arch)")
              Text("支持操作：\(capabilityLabels)")
                .fixedSize(horizontal: false, vertical: true)
              if let seen = device.lastSeenAt {
                Text("最近观察：\(Date(timeIntervalSince1970: Double(seen) / 1000).formatted())")
              }
            }
            .padding(.top, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
          }
          .disclosureGroupStyle(DeviceDisclosureStyle())
          .font(Theme.TypeScale.pill)
          .foregroundStyle(Theme.Palette.textMuted)
        }
      }
      Spacer(minLength: 0)
    }
    .accessibilityElement(children: .combine)
  }

  private var capabilityLabels: String {
    guard let capabilities = device.capabilities else { return "尚未观察到" }
    let labels = [
      "command": "运行命令", "file.read": "读取文件", "file.write": "写入文件", "file.list": "浏览目录",
      "native": "本机工具",
    ]
    return capabilities.isEmpty
      ? "无" : capabilities.map { labels[$0] ?? "其他操作" }.joined(separator: "、")
  }

  private var statusLabel: String {
    if isLocal && !serviceEnabled { return "设备服务已关闭" }
    if isLocal && !localReady { return "本机未就绪" }
    if stale { return isLocal && localReady ? "本机可用 · 云端观察待刷新" : "观察待刷新" }
    return isLocal && localReady ? "本机可用 · \(device.connectionLabel)" : device.connectionLabel
  }
}

/// Keep native disclosure state and Button keyboard/AX actions with a full rectangular target.
private struct DeviceDisclosureStyle: DisclosureGroupStyle {
  func makeBody(configuration: Configuration) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        configuration.isExpanded.toggle()
      } label: {
        HStack {
          configuration.label
          Spacer(minLength: 12)
          Image(systemName: configuration.isExpanded ? "chevron.down" : "chevron.right")
            .accessibilityHidden(true)
        }
        .padding(.horizontal, 4)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityValue(configuration.isExpanded ? "已展开" : "已折叠")
      if configuration.isExpanded { configuration.content }
    }
  }
}
