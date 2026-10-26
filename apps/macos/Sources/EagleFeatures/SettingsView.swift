import EagleDesign
import SwiftUI

/// The settings window content, one screen per rail section.
public struct SettingsView: View {
  @StateObject private var model: SettingsViewModel
  @AppStorage("eagle.appearance") private var appearance = "system"
  @AppStorage("eagle.hideToolCalls") private var hideToolCalls = false
  private let onClose: () -> Void
  private let daemon: BotsDaemonSupervisor?

  public init(
    model: SettingsViewModel = SettingsViewModel(),
    onClose: @escaping () -> Void = {},
    daemon: BotsDaemonSupervisor? = nil
  ) {
    _model = StateObject(wrappedValue: model)
    self.onClose = onClose
    self.daemon = daemon
  }

  public var body: some View {
    SettingsScaffold(selection: $model.selection, onClose: onClose) {
      switch model.selection {
      case .general:
        general
      case .bots:
        bots
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
          SettingsRow("隐藏工具调用", detail: "对话里不显示工具调用和结果") {
            Toggle("", isOn: $hideToolCalls)
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

  /// Model gateway: the one place a person configures the bot's endpoint, key and model.
  private var bots: some View {
    VStack(alignment: .leading, spacing: 18) {
      if let daemon {
        SettingsCaption("Bot 服务")
        BotsDaemonCard(daemon: daemon)
      }
      SettingsCaption("Bot 使用这台机器上的模型网关，保存后立即生效。")
      SettingsCard {
        VStack(alignment: .leading, spacing: 14) {
          gatewayField(
            "网关地址",
            detail: "OpenAI 兼容地址，例如 http://127.0.0.1:3425/v1"
          ) {
            SettingsTextField("https://…/v1", text: $model.gatewayBaseURL)
          }
          gatewayField(
            "API Key",
            detail: model.gateway?.hasApiKey == true ? "已保存；留空则保持不变" : "与网关匹配的密钥"
          ) {
            SettingsTextField(
              model.gateway?.hasApiKey == true ? "已保存" : "sk-…",
              text: $model.gatewayAPIKey,
              secure: true
            )
          }
          gatewayField("模型", detail: "Bot 使用的模型 id，例如 auto/gpt-6-astra") {
            SettingsTextField("模型 id", text: $model.gatewayModel)
          }
          HStack(spacing: 10) {
            SettingsActionButton("测试连接") {
              Task { @MainActor in await model.testGateway() }
            }
            .disabled(model.gatewayBusy)
            SettingsActionButton("保存", prominent: true) {
              Task { @MainActor in await model.saveGateway() }
            }
            .disabled(model.gatewayBusy)
            if model.gatewayBusy { SpinnerArc(size: 12) }
            Spacer(minLength: 0)
            if let probe = model.gatewayProbe {
              Label(
                "\(probe.message) · \(probe.latencyMs) ms",
                systemImage: probe.ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
              )
              .font(Theme.TypeScale.note)
              .foregroundStyle(probe.ok ? Theme.Palette.accentStrong : Theme.Palette.destructive)
            } else if let message = model.gatewayMessage {
              Text(message)
                .font(Theme.TypeScale.note)
                .foregroundStyle(Theme.Palette.textSecondary)
            }
          }
        }
        .padding(.vertical, 16)
      }
    }
    .task { @MainActor in await model.loadGatewayIfNeeded() }
  }

  private func gatewayField<Content: View>(
    _ title: String,
    detail: String,
    @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(title)
        .font(.system(size: 13.5, weight: .medium))
        .foregroundStyle(Theme.Palette.textPrimary)
      content()
        .frame(maxWidth: 460)
      Text(detail)
        .font(.system(size: 11.5))
        .foregroundStyle(Theme.Palette.textMuted)
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

/// The daemon's live state: running (and who started it), stopped or failed, with the root
/// and port the app is wired to. This is where a first-run problem such as a missing Node
/// becomes visible instead of a silent connection error.
private struct BotsDaemonCard: View {
  @ObservedObject var daemon: BotsDaemonSupervisor

  var body: some View {
    SettingsCard {
      VStack(alignment: .leading, spacing: 10) {
        HStack(spacing: 8) {
          Circle()
            .fill(tint)
            .frame(width: 8, height: 8)
          Text(statusText)
            .font(.system(size: 14))
            .foregroundStyle(Theme.Palette.textPrimary)
          Spacer(minLength: 8)
          actions
        }
        Text("根目录 \(daemon.rootPath) · 端口 \(daemon.port)")
          .font(.system(size: 11.5, design: .monospaced))
          .foregroundStyle(Theme.Palette.textMuted)
          .lineLimit(1)
          .truncationMode(.middle)
        if case .failed(let message) = daemon.status {
          Text(message)
            .font(Theme.TypeScale.note)
            .foregroundStyle(Theme.Palette.destructive)
            .fixedSize(horizontal: false, vertical: true)
        }
        Toggle("启动 App 时自动运行", isOn: $daemon.autoStart)
          .toggleStyle(.switch)
          .tint(Theme.Palette.accentStrong)
          .font(.system(size: 13))
      }
      .padding(.vertical, 14)
    }
  }

  @ViewBuilder
  private var actions: some View {
    switch daemon.status {
    case .starting:
      SpinnerArc(size: 12)
    case .running(_, _, let external):
      if !external {
        SettingsActionButton("重启") { Task { await daemon.restart() } }
        SettingsActionButton("停止") { Task { await daemon.stop() } }
      } else {
        Text("由外部启动，不随 App 退出")
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.textMuted)
      }
    case .stopped, .failed:
      SettingsActionButton("启动", prominent: true) { Task { await daemon.startIfNeeded() } }
    }
  }

  private var statusText: String {
    switch daemon.status {
    case .stopped: return "未运行"
    case .starting: return "正在启动…"
    case .running(let version, let pid, let external):
      return "运行中 · v\(version) · pid \(pid)\(external ? "（外部）" : "")"
    case .failed: return "启动失败"
    }
  }

  private var tint: Color {
    switch daemon.status {
    case .stopped: return Theme.Palette.textMuted
    case .starting: return Theme.Palette.avatarTint(3)
    case .running: return Theme.Palette.accentStrong
    case .failed: return Theme.Palette.destructive
    }
  }
}
