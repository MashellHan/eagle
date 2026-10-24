import EagleDesign
import SwiftUI

/// The settings window content, one screen per rail section.
public struct SettingsView: View {
  @StateObject private var model: SettingsViewModel
  @AppStorage("eagle.appearance") private var appearance = "system"
  private let onClose: () -> Void

  public init(model: SettingsViewModel = SettingsViewModel(), onClose: @escaping () -> Void = {}) {
    _model = StateObject(wrappedValue: model)
    self.onClose = onClose
  }

  public var body: some View {
    SettingsScaffold(selection: $model.selection, onClose: onClose) {
      switch model.selection {
      case .general:
        general
      case .machines:
        machines
      case .realtime:
        realtime
      case .usage:
        usage
      case .updates:
        updates
      }
    }
  }

  private var general: some View {
    VStack(alignment: .leading, spacing: 18) {
      SettingsCard {
        VStack(spacing: 0) {
          SettingsRow("登录时自动启动", detail: "让 Eagle 在后台保持机器在线") {
            Toggle("", isOn: $model.launchAtLogin)
              .labelsHidden()
              .toggleStyle(.switch)
              .tint(Theme.Palette.accentStrong)
          }
          Divider().overlay(Theme.Palette.line)
          SettingsRow("显示未聚焦的 Space", detail: "侧栏同时列出所有 Herdr 工作区") {
            Toggle("", isOn: $model.showUnfocusedSpaces)
              .labelsHidden()
              .toggleStyle(.switch)
              .tint(Theme.Palette.accentStrong)
          }
          Divider().overlay(Theme.Palette.line)
          SettingsRow("外观", detail: "浅色、深色或跟随系统") {
            PillMenu(appearanceLabel) { cycleAppearance() }
          }
        }
      }
    }
  }

  private var appearanceLabel: String {
    switch appearance {
    case "light": return "浅色"
    case "dark": return "深色"
    default: return "跟随系统"
    }
  }

  private func cycleAppearance() {
    appearance =
      switch appearance {
      case "system": "light"
      case "light": "dark"
      default: "system"
      }
  }

  private var machines: some View {
    VStack(alignment: .leading, spacing: 18) {
      SettingsCard {
        VStack(spacing: 2) {
          ForEach(model.machines) { machine in
            DeviceRow(
              symbol: machine.symbol,
              name: machine.name,
              status: machine.status,
              online: machine.online,
              permission: machine.permission.rawValue,
              onPermission: { model.cyclePermission(machine.id) },
              onRename: machine.renamable ? { model.beginRename(machine.id) } : nil,
              onMore: { model.remove(machine.id) }
            )
          }
        }
        .padding(.vertical, 8)
      }

      SettingsCaption("Eagle 的机器")
      SettingsCard {
        VStack(alignment: .leading, spacing: 12) {
          Text("更新 Eagle 的机器")
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(Theme.Palette.textPrimary)
          Text("所有机器共用同一个 Agent 版本。文件与登录信息保留，已安装的 Agent 会被替换；每台机器会依次重启采集服务。")
            .font(.system(size: 13))
            .foregroundStyle(Theme.Palette.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
          InfoBanner("所有机器的 Agent 均为最新版本")
        }
        .padding(.vertical, 16)
      }

      SettingsCard {
        HStack(alignment: .center, spacing: 20) {
          VStack(alignment: .leading, spacing: 6) {
            Text("重置 Eagle 的机器")
              .font(.system(size: 15, weight: .semibold))
              .foregroundStyle(Theme.Palette.textPrimary)
            Text("当机器卡住时可以重新开始。它会按上一次完整快照重建，最近的改动可能丢失。")
              .font(.system(size: 13))
              .foregroundStyle(Theme.Palette.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }
          Spacer(minLength: 0)
          DestructivePill("重置") {}
        }
        .padding(.vertical, 16)
      }
    }
  }

  private var realtime: some View {
    VStack(alignment: .leading, spacing: 18) {
      SettingsCard {
        VStack(spacing: 0) {
          SettingsRow("自动跟随终端输出", detail: "打开 Space 时立即显示最新画面") {
            Toggle("", isOn: $model.followTerminal)
              .labelsHidden()
              .toggleStyle(.switch)
              .tint(Theme.Palette.accentStrong)
          }
          Divider().overlay(Theme.Palette.line)
          SettingsRow("允许从网页发送输入", detail: "接管输入前仍需要在终端侧确认") {
            Toggle("", isOn: $model.allowRemoteInput)
              .labelsHidden()
              .toggleStyle(.switch)
              .tint(Theme.Palette.accentStrong)
          }
        }
      }
      SettingsCaption("在线机器 \(model.onlineCount) 台")
    }
  }

  private var usage: some View {
    VStack(alignment: .leading, spacing: 18) {
      SettingsCard {
        VStack(spacing: 0) {
          SettingsRow("今日上报", detail: "全部机器的完整快照") {
            Text("\(model.usage.reportsToday)").font(Theme.TypeScale.mono)
              .foregroundStyle(Theme.Palette.textPrimary)
          }
          Divider().overlay(Theme.Palette.line)
          SettingsRow("今日 API 调用", detail: "网页与 Agent 合计") {
            Text("\(model.usage.apiCallsToday)").font(Theme.TypeScale.mono)
              .foregroundStyle(Theme.Palette.textPrimary)
          }
          Divider().overlay(Theme.Palette.line)
          SettingsRow("归档存储", detail: "D1 中的日报与语义记录") {
            Text("\(model.usage.storageMegabytes) MB").font(Theme.TypeScale.mono)
              .foregroundStyle(Theme.Palette.textSecondary)
          }
        }
      }
      SettingsCaption("\(model.usage.planName) 计划 · 已用 \(model.usage.percentUsed)%")
    }
  }

  private var updates: some View {
    VStack(alignment: .leading, spacing: 18) {
      SettingsCard {
        VStack(alignment: .leading, spacing: 12) {
          switch model.updateState {
          case .idle:
            HStack {
              Text("检查 Eagle 的新版本")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.Palette.textPrimary)
              Spacer()
              Button("检查更新") { model.checkForUpdates() }
            }
          case .checking:
            HStack(spacing: 10) {
              SpinnerArc()
              Text("正在检查更新…")
                .font(.system(size: 13))
                .foregroundStyle(Theme.Palette.textSecondary)
            }
          case .current(let version):
            Text("Eagle \(version)")
              .font(.system(size: 15, weight: .semibold))
              .foregroundStyle(Theme.Palette.textPrimary)
            InfoBanner("当前已是最新版本")
          }
        }
        .padding(.vertical, 16)
      }
    }
  }
}
