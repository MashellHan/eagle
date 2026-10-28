import EagleDesign
import SwiftUI

@MainActor private final class HerdrPresentation: ObservableObject {
  @Published var confirmsRecovery = false
}

public struct MachineHerdrView: View {
  @ObservedObject private var model: MachineHerdrModel
  @Environment(\.dismiss) private var dismiss
  @StateObject private var presentation = HerdrPresentation()
  public init(model: MachineHerdrModel) { self.model = model }
  public var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        VStack(alignment: .leading, spacing: 5) {
          Text("Herdr · \(model.machine.name)").font(.title3.weight(.semibold))
          Text(model.machine.id).font(Theme.TypeScale.mono).foregroundStyle(
            Theme.Palette.textSecondary)
        }
        Spacer()
        SettingsActionButton("关闭") { dismiss() }
      }
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          SettingsCard {
            VStack(alignment: .leading, spacing: 10) {
              HStack {
                Text(model.status?.label ?? "状态未知").font(.headline)
                Spacer()
                SettingsActionButton("检测") { Task { await model.perform("probe") } }.disabled(
                  !model.canStart)
                if model.busy { SpinnerArc(size: 12) }
              }
              if let status = model.status {
                check("CLI", status.checks.cli, detail: status.version)
                check("服务连接", status.checks.server)
                check("会话", status.checks.session, detail: status.session)
                check("工具", status.checks.tools)
                if let observed = status.observedAt {
                  Text("检查时间：\(localTime(observed))").font(Theme.TypeScale.note).foregroundStyle(
                    Theme.Palette.textSecondary)
                }
                if status.state == "needs_local_setup" {
                  Text("所选会话尚未运行。请选择已有会话，或明确创建新会话。")
                    .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
                }
                if status.state == "unavailable" {
                  Text("请在此机器检查 Herdr CLI、服务兼容性与安装权限，再重新检测。")
                    .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
                }
              } else {
                Text("需要在线的基础 Agent 进行实际检测。Herdr 不影响基础文件和命令能力。")
                  .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
              }
            }.padding(.vertical, 14)
          }
          if model.status?.state == "not_installed" {
            SettingsActionButton("在此机器安装 Herdr") { Task { await model.perform("install") } }
              .disabled(!model.canStart)
            Text("使用 Herdr 官方安装器。已有安装会先检测；安装后仍需选择会话并验证。")
              .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
          }
          if model.status?.installed == true {
            SettingsCard {
              VStack(alignment: .leading, spacing: 12) {
                Picker("会话方式", selection: $model.createNew) {
                  Text("选已有会话").tag(false)
                  Text("创建新会话").tag(true)
                }.pickerStyle(.segmented)
                if model.createNew {
                  SettingsTextField("新的会话名称", text: $model.newSession)
                  Text("在此机器后台创建，不停止或替换现有会话。名称可用字母、数字、连字符和下划线。")
                    .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                  SettingsActionButton("创建并启用") { Task { await model.perform("create_session") } }
                    .disabled(model.newSession.isEmpty)
                } else {
                  Picker("Herdr 会话", selection: $model.selectedSession) {
                    Text("请选择会话").tag("")
                    ForEach(model.status?.sessions ?? []) { session in
                      Text(session.running ? session.name : "\(session.name) · 未运行").tag(
                        session.name)
                    }
                  }
                  Toggle("允许 Eagle 使用此会话", isOn: $model.enabled).toggleStyle(.switch).tint(
                    Theme.Palette.accentStrong)
                  HStack {
                    SettingsActionButton("保存并验证") { Task { await model.perform("configure") } }
                      .disabled(model.selectedSession.isEmpty)
                    if model.status?.enabled == true {
                      SettingsActionButton("停用插件") { Task { await model.perform("disable") } }
                    }
                  }
                  Text("停用插件不会停止 Herdr 会话。")
                    .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
                }
              }.padding(.vertical, 14).disabled(!model.canStart)
            }
          }
          if let reference = model.reference {
            SettingsCard {
              VStack(alignment: .leading, spacing: 8) {
                Text(model.historical ? "历史操作结果" : "本次操作").font(.headline)
                Text(reference.id).font(Theme.TypeScale.mono).textSelection(.enabled)
                Text("发起于 \(reference.createdAt.formatted(date: .abbreviated, time: .standard))")
                  .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
                if let message = model.message {
                  Text(message).font(Theme.TypeScale.note).fixedSize(
                    horizontal: false, vertical: true)
                }
                if model.unresolved {
                  Text("已保留原 ID。请先查询；确认结束前不能再次安装或创建会话。关闭后仍可回来查询。")
                    .font(Theme.TypeScale.note).fixedSize(horizontal: false, vertical: true)
                }
                HStack {
                  SettingsActionButton("查询结果") { Task { await model.query() } }.disabled(model.busy)
                  if model.busy || model.unresolved {
                    SettingsActionButton("请求取消") { Task { await model.cancel() } }
                  }
                }
                if model.canContinueAfterInspection {
                  SettingsActionButton("已核对目标，保留记录并继续…") { presentation.confirmsRecovery = true }
                }
              }.padding(.vertical, 14)
            }
          } else if let message = model.message {
            Text(message).font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
          }
          if !model.savedReferences.isEmpty {
            DisclosureGroup("保留的操作 ID（\(model.savedReferences.count)）") {
              ForEach(model.savedReferences, id: \.id) { reference in
                VStack(alignment: .leading, spacing: 6) {
                  Text(reference.id).font(Theme.TypeScale.mono).textSelection(.enabled)
                  SettingsActionButton("查询此记录") {
                    Task { await model.querySaved(reference) }
                  }.disabled(!model.canStart)
                }.padding(.vertical, 8)
              }
            }
          }
          Text("关闭面板不会取消已开始的远端操作。重开先查询原操作 ID；历史结果不代表当前连接仍可用。")
            .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
    .padding(24).frame(width: 560, height: 650)
    .foregroundStyle(Theme.Palette.textPrimary).background(Theme.Palette.canvas)
    .task {
      model.activate()
      await model.load()
    }
    .onDisappear { model.invalidate() }
    .confirmationDialog("已在目标 Mac 核对原操作的实际影响？", isPresented: $presentation.confirmsRecovery) {
      Button("保留原 ID，继续检测") { model.continueAfterInspection() }
      Button("继续查询原操作", role: .cancel) {}
    } message: {
      Text("未知结果不会变成成功，也不会自动重试。请先核对安装和会话；原 ID 将保留供以后查询。")
    }
  }
  private func check(_ name: String, _ value: Bool?, detail: String? = nil) -> some View {
    HStack {
      Text(name)
      if let detail { Text(detail).foregroundStyle(Theme.Palette.textSecondary).lineLimit(1) }
      Spacer()
      Label(
        value == true ? "已验证" : value == false ? "未就绪" : "未检测",
        systemImage: value == true ? "checkmark.circle" : "circle.dotted")
    }.font(Theme.TypeScale.note)
  }
  private func localTime(_ value: String) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions =
      value.contains(".")
      ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
    return formatter.date(from: value)?.formatted(date: .abbreviated, time: .standard) ?? "未知"
  }
}
