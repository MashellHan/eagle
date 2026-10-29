import BotsCore
import EagleDesign
import SwiftUI

/// The sheet owns the Bot it was opened for, independently of sidebar selection.
public struct BotRemoteGrantView: View {
  @ObservedObject private var model: BotRemoteGrantModel
  @Environment(\.dismiss) private var dismiss
  private let onOpenMachines: () -> Void
  private let onOpenTools: () -> Void
  public init(
    model: BotRemoteGrantModel, onOpenMachines: @escaping () -> Void = {},
    onOpenTools: @escaping () -> Void = {}
  ) {
    self.model = model
    self.onOpenMachines = onOpenMachines
    self.onOpenTools = onOpenTools
  }
  public var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack(alignment: .top) {
        VStack(alignment: .leading, spacing: 4) {
          Text("机器授权 · \(model.botTitle)").font(.title3.weight(.semibold))
          Text("仅适用于此 Bot").font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
        }
        Spacer()
        SettingsActionButton("关闭") { dismiss() }
      }
      if let message = model.message {
        Text(message).font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
          .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier(
            "bot-remote-message")
      }
      if model.busy || model.refreshing {
        HStack {
          SpinnerArc(size: 12)
          Text(model.busy ? "正在核对并保存授权…" : "正在读取授权与机器…").font(Theme.TypeScale.note)
        }
      }
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          SettingsCard {
            VStack(alignment: .leading, spacing: 10) {
              Text(model.deploymentSummary).font(Theme.TypeScale.note)
                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
              Text("使用 Eagle 已保存的部署，授权凭据由本机钥匙串管理。无需向 Bot 粘贴任何 token。")
                .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
              HStack {
                SettingsActionButton("刷新授权与机器") { Task { await model.load() } }
                  .disabled(model.busy || model.refreshing)
                SettingsActionButton("机器设置…") {
                  dismiss()
                  onOpenMachines()
                }
                .disabled(model.busy)
              }
            }.padding(.vertical, 14)
          }
          if let configuration = model.configuration {
            SettingsCaption("此 Bot 的机器授权")
            if configuration.cleanupPending {
              Text("旧绑定已禁止使用，凭据清理尚未完成。")
                .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
              SettingsActionButton("重试清理") { Task { await model.retryCleanup() } }
                .disabled(!model.canRevoke)
            }
            if configuration.targets.isEmpty {
              Text("此 Bot 尚未授权任何机器。")
                .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
            }
            ForEach(configuration.targets) { target in
              SettingsCard {
                VStack(alignment: .leading, spacing: 8) {
                  HStack {
                    Text(target.alias).font(.headline)
                    Spacer()
                    Text(target.enabled ? "已授权" : "尚未启用")
                      .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
                  }
                  Text(machineLabel(target)).font(Theme.TypeScale.note)
                  Text(target.operations.map(Self.title).joined(separator: " · "))
                    .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                  Text(target.origin).font(Theme.TypeScale.note).foregroundStyle(
                    Theme.Palette.textSecondary
                  )
                  .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                  HStack {
                    SettingsActionButton("修改范围") { model.edit(target) }
                      .disabled(model.busy || target.origin != model.connectedAddress)
                    SettingsActionButton("撤销授权") {
                      Task { await model.revoke(alias: target.alias) }
                    }
                    .disabled(!model.canRevoke)
                  }
                }.padding(.vertical, 14)
              }
            }
          }
          SettingsCaption(model.editingAlias == nil ? "添加机器授权" : "修改授权范围")
          if let reason = model.grantUnavailableReason {
            Text(reason).font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }
          if model.needsHelper {
            SettingsActionButton("关闭面板以重新连接") { dismiss() }
          }
          SettingsCard {
            VStack(alignment: .leading, spacing: 12) {
              Picker("目标机器", selection: $model.selectedMachineID) {
                Text("请选择机器").tag("")
                ForEach(model.machines.filter { $0.machine.enabled }) { row in
                  Text("\(row.machine.name) · \(row.online ? "在线" : "离线或状态未知")").tag(row.id)
                }
              }
              SettingsTextField("短名称，如 build-mac", text: $model.alias)
              Text("短名称使用字母、数字、连字符或下划线，供 Bot 选择目标。")
                .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
              ForEach(RemoteToolPermission.allCases, id: \.rawValue) { permission in
                Toggle(
                  Self.title(permission),
                  isOn: Binding(
                    get: { model.permissions.contains(permission) },
                    set: { enabled in
                      if enabled {
                        model.permissions.insert(permission)
                      } else {
                        model.permissions.remove(permission)
                      }
                    })
                )
                .toggleStyle(.checkbox).font(Theme.TypeScale.note)
              }
              Text("文件工具只能访问目标 Mac 明确授权的目录；命令按目标 Agent 账户权限执行。")
                .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
              HStack {
                SettingsActionButton(model.editingAlias == nil ? "授权给此 Bot" : "保存授权范围") {
                  Task { await model.grant() }
                }.disabled(!model.canGrant || model.alias.isEmpty)
                if model.editingAlias != nil {
                  SettingsActionButton("取消修改") { model.cancelEditing() }
                }
              }
            }.padding(.vertical, 14).disabled(model.busy || model.refreshing)
          }
          Text("远程机器工具组在 Bot 工具设置中单独启用。授权不会自动打开工具组，关闭工具组也不会撤销授权。")
            .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
          SettingsActionButton("Bot 工具设置…") {
            dismiss()
            onOpenTools()
          }
        }
      }
    }
    .padding(24).frame(width: 570, height: 690)
    .foregroundStyle(Theme.Palette.textPrimary).background(Theme.Palette.canvas)
    .onDisappear { model.invalidate() }
  }
  private func machineLabel(_ target: BotRemoteTarget) -> String {
    guard let row = model.machines.first(where: { $0.id == target.machineId }),
      target.origin == model.connectedAddress
    else { return "\(target.machineId) · 状态未知" }
    return "\(row.machine.name) · \(row.statusText)"
  }
  private static func title(_ permission: RemoteToolPermission) -> String {
    switch permission {
    case .command: return "执行命令"
    case .readFile: return "读取文件"
    case .listFiles: return "列出目录"
    case .setupHerdr: return "配置 Herdr"
    case .inspectHerdr: return "查看 Herdr"
    }
  }
}
