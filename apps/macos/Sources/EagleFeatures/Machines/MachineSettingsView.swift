import AppKit
import EagleDesign
import SwiftUI

@MainActor private final class MachineSettingsPresentation: ObservableObject {
  @Published var fileGrantsExpanded = false
  @Published var pluginTarget: MachineHerdrModel?
  @Published var plugins: [String: MachineHerdrModel] = [:]
}

/// The deployment's registered machines, independent of the local Bots catalog.
public struct MachineSettingsView: View {
  @StateObject private var model: MachineSettingsModel
  @StateObject private var presentation = MachineSettingsPresentation()
  private let operationStore: any MachineOperationStore

  public init(
    model: MachineSettingsModel? = nil,
    operationStore: (any MachineOperationStore)? = nil,
    configuration: AppLaunchConfiguration = .current
  ) {
    _model = StateObject(
      wrappedValue: model ?? MachineSettingsModel.live(configuration: configuration))
    if let operationStore {
      self.operationStore = operationStore
    } else if model == nil {
      self.operationStore = DefaultsMachineOperationStore(defaults: configuration.defaults)
    } else {
      self.operationStore = MemoryMachineOperationStore()
    }
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      connection
      localService
      HStack {
        SettingsCaption("已接入的机器")
        Spacer()
        if model.refreshing { SpinnerArc(size: 12) }
        SettingsActionButton("刷新") { Task { await model.refresh() } }
          .disabled(model.busy || model.connectedAddress == nil)
      }
      directory
      SettingsCaption("Herdr 是可选插件，基础机器连接和执行无需安装 Herdr。")
    }
    .task {
      model.activate()
      await model.load()
      await model.refreshLocal()
      while !Task.isCancelled {
        do { try await Task.sleep(for: .seconds(5)) } catch { return }
        await model.refresh()
        await model.refreshLocal()
      }
    }
    .onDisappear {
      model.invalidate()
      for plugin in presentation.plugins.values { plugin.invalidate() }
    }
    .sheet(item: $presentation.pluginTarget) { MachineHerdrView(model: $0) }
    .onChange(of: model.connectedAddress) { _, _ in
      for plugin in presentation.plugins.values { plugin.invalidate() }
      presentation.pluginTarget = nil
    }
    .onChange(of: model.phase) { _, phase in
      if phase == .failed(.authentication) {
        for plugin in presentation.plugins.values { plugin.invalidate() }
      }
    }
    .alert(
      "重命名机器",
      isPresented: Binding(
        get: { model.renameTarget != nil }, set: { if !$0 { model.renameTarget = nil } }
      )
    ) {
      TextField("机器名称", text: $model.renameText)
      Button("保存") { if let id = model.renameTarget { Task { await model.rename(id: id) } } }
      Button("取消", role: .cancel) { model.renameTarget = nil }
    }
    .confirmationDialog(
      "停用此机器的接入？",
      isPresented: Binding(
        get: { model.revokeTarget != nil }, set: { if !$0 { model.revokeTarget = nil } }
      ), titleVisibility: .visible
    ) {
      Button("停用接入", role: .destructive) {
        if let id = model.revokeTarget { Task { await model.revoke(id: id) } }
      }
      Button("取消", role: .cancel) { model.revokeTarget = nil }
    } message: {
      Text("机器凭据将失效。在途操作的结果仍须核对，停用接入不保证已发生的操作被撤销。")
    }
  }

  @ViewBuilder private var connection: some View {
    if model.hasSavedCredential && !model.editingConnection
      && model.phase != .failed(.authentication)
    {
      VStack(alignment: .leading, spacing: 8) {
        SettingsCaption("云端连接")
        SettingsCard {
          HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
              Text(model.connectedAddress ?? "已保存部署").font(Theme.TypeScale.note)
                .foregroundStyle(Theme.Palette.textPrimary).textSelection(.enabled)
              Text(model.phase == .ready ? "已连接 · 凭据保存在钥匙串" : "连接状态需核对")
                .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
            }
            Spacer()
            SettingsActionButton("编辑连接") { model.editingConnection = true }
              .disabled(model.busy || model.localBusy)
          }.padding(.vertical, 14)
        }
      }
    } else {
      connectionForm
    }
  }

  private var connectionForm: some View {
    VStack(alignment: .leading, spacing: 8) {
      SettingsCaption("云端连接")
      SettingsCard {
        VStack(alignment: .leading, spacing: 12) {
          field("部署地址") { SettingsTextField("https://…", text: $model.address) }
          field("部署凭据") {
            SettingsTextField(
              model.hasSavedCredential ? "已保存；留空保持" : "此部署的所有者凭据", text: $model.credential,
              secure: true)
          }
          Toggle("此部署需要 Cloudflare Access 凭据", isOn: $model.useAccess)
            .toggleStyle(.switch).tint(Theme.Palette.accentStrong)
            .font(Theme.TypeScale.note)
          if model.useAccess {
            field("Access Client ID") {
              SettingsTextField("Client ID", text: $model.accessID, secure: true)
            }
            field("Access Client Secret") {
              SettingsTextField("Client Secret", text: $model.accessSecret, secure: true)
            }
            Text("已保存的 Access 凭据可整组留空保持；更换时请同时填写两项。")
              .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
          }
          HStack(spacing: 10) {
            SettingsActionButton("测试连接") { Task { await model.testConnection() } }
            SettingsActionButton(model.connectionSaveTitle) {
              Task { await model.saveAndConnect() }
            }
            if model.busy { SpinnerArc(size: 12) }
          }
          .disabled(model.busy || model.localBusy)
          if let message = model.message {
            Text(message).font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
              .accessibilityIdentifier("machine-connection-message")
          }
          if model.credentialReadFailed {
            SettingsActionButton("重新读取已保存连接") { Task { await model.load() } }
          }
          if let address = model.connectedAddress {
            Text("已保存部署：\(address)")
              .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
              .lineLimit(2).textSelection(.enabled)
          }
          Text("凭据保存在这台 Mac 的钥匙串中；更换部署地址需要对应的新凭据。")
            .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
          if model.connectionSaveTitle != "保存并连接" {
            Text("保存前将撤销旧连接下各 Bot 的机器授权并清理复制的凭据；新连接需要重新授权。清理失败时保留原连接。")
              .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        .padding(.vertical, 16)
      }
    }
  }

  private func field<Content: View>(
    _ title: String, @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(title).font(.system(size: 13.5, weight: .medium)).foregroundStyle(
        Theme.Palette.textPrimary)
      content().frame(maxWidth: 460).disabled(model.busy || model.localBusy)
    }
  }

  private var localService: some View {
    VStack(alignment: .leading, spacing: 8) {
      SettingsCaption("本机执行服务")
      SettingsCard {
        VStack(alignment: .leading, spacing: 12) {
          nodeSettings
          if !model.localAgentAvailable {
            Text("当前 App 缺少 Agent 或找不到 Node.js。请使用包含执行端的安装包，并安装或选择 Node.js 24+。")
              .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          } else {
            if let state = model.localState {
              Label(
                state.running == true
                  ? "本机服务运行中"
                  : state.running == nil ? "本机服务状态未知" : state.installed ? "本机服务未运行" : "本机服务尚未安装",
                systemImage: state.running == true ? "checkmark.circle" : "circle.dotted"
              )
              .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textPrimary)
              if state.disabled == true {
                Text("已停用自动加载").font(Theme.TypeScale.note).foregroundStyle(
                  Theme.Palette.textSecondary)
              }
              if let code = state.lastExit, code != 0 {
                Text("上次服务退出码：\(code)").font(Theme.TypeScale.note).foregroundStyle(
                  Theme.Palette.textSecondary)
              }
            } else {
              Text("本机服务状态尚未确认").font(Theme.TypeScale.note).foregroundStyle(
                Theme.Palette.textSecondary)
            }
            if model.localState?.installed != true || model.editingLocal {
              if !model.canRepairLocal {
                field("机器名称") { SettingsTextField("这台 Mac 的名称", text: $model.localMachineName) }
              }
              field("Agent 接入地址") {
                SettingsTextField("https://eagle-ingest.…", text: $model.agentAddress)
              }
              if model.requiresLocalRotation {
                Text("请核对现有接入地址并明确填入；重新签发将绑定当前管理部署。")
                  .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
              }
              Text("此地址用于机器接入，可能不同于上方管理部署地址。")
                .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
              Toggle("允许命令执行", isOn: $model.localCommands).toggleStyle(.switch)
                .tint(Theme.Palette.accentStrong).font(Theme.TypeScale.note)
                .disabled(model.localBusy)
              if model.localCommands {
                field("命令工作目录") { SettingsTextField("绝对路径", text: $model.commandDirectory) }
                Text("命令使用 Agent 账户的系统权限；工作目录不会限制文件访问。")
                  .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
                  .fixedSize(horizontal: false, vertical: true)
              }
              if !model.requiresLocalRotation {
                SettingsActionButton(model.canRepairLocal ? "保存本机设置并启动" : "启用本机执行") {
                  Task { await model.enableLocal(repair: model.canRepairLocal) }
                }
                .disabled(model.localBusy || !model.canManage || !model.canIssue)
              }
              if model.canRecoverLocal || model.canRepairLocal {
                Text("重新签发会立即使此本机 ID 的旧凭据失效。")
                  .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
                SettingsActionButton(model.requiresLocalRotation ? "重新签发并绑定到此部署" : "重新签发并接入") {
                  Task { await model.enableLocal(rotate: true, repair: model.canRepairLocal) }
                }
                .disabled(model.localBusy || !model.canManage)
              }
            }
            HStack {
              SettingsActionButton("读取服务状态") { Task { await model.refreshLocal() } }
              if model.localState?.installed == true {
                if model.localState?.running != true {
                  SettingsActionButton("启动") { Task { await model.controlLocal("start") } }
                }
                if model.localState?.loaded == true || model.localState?.disabled != true {
                  SettingsActionButton("停止服务") { Task { await model.controlLocal("stop") } }
                }
                SettingsActionButton("本机设置…") { Task { await model.readLocalConfiguration() } }
              }
              if model.localBusy { SpinnerArc(size: 12) }
            }.disabled(model.localBusy)
            if model.localState?.installed == true {
              localFiles
            }
          }
          if let message = model.localMessage {
            Text(message).font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }
          Text("退出 App 不会停止独立执行服务。运行中不等于已连接云端。")
            .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
        }.padding(.vertical, 16)
      }
    }
  }

  private var localFiles: some View {
    DisclosureGroup("文件授权（仅此 Mac）", isExpanded: $presentation.fileGrantsExpanded) {
      VStack(alignment: .leading, spacing: 10) {
        Text("授权只用于有界文件读取和目录列表，不限制命令的系统权限。远端目录须在目标 Mac 上授权。")
          .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
        ForEach(model.localFileGrants) { grant in
          HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 3) {
              Text(grant.name).font(Theme.TypeScale.note)
              Text(grant.root).font(Theme.TypeScale.note).foregroundStyle(
                Theme.Palette.textSecondary
              ).textSelection(.enabled)
            }
            Spacer()
            SettingsActionButton("撤销授权") { Task { await model.removeFileGrant(id: grant.id) } }
              .disabled(model.localBusy)
          }
        }
        HStack {
          SettingsActionButton("添加目录…") {
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.allowsMultipleSelection = false
            panel.message = "选择允许这台 Mac 的文件工具读取的目录；可随时撤销。"
            if panel.runModal() == .OK, let path = panel.url?.path {
              Task { await model.addFileGrant(path: path) }
            }
          }.disabled(!model.canManage)
          SettingsActionButton("读取授权") { Task { await model.refreshFileGrants() } }
        }.disabled(model.localBusy)
        if let message = model.fileGrantMessage {
          Text(message).font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
        }
      }.padding(.top, 8)
    }.font(Theme.TypeScale.note)
      .onChange(of: presentation.fileGrantsExpanded) { _, expanded in
        if expanded { Task { await model.refreshFileGrants() } }
      }
  }

  private func openHerdr(_ row: MachineRow) {
    guard let connection = model.pluginConnection(id: row.id) else { return }
    let key = connection.origin.absoluteString + "|" + row.id
    presentation.plugins[key]?.invalidate()
    let current: MachineHerdrStatus?
    if case .observed(let status) = row.observation, status.online {
      current = status.capabilities?.herdr
    } else {
      current = nil
    }
    let plugin = MachineHerdrModel(
      machine: row.machine, connection: connection, status: current, store: operationStore,
      authorized: { [weak model] in model?.pluginConnection(id: row.id) == connection },
      authenticationFailed: { [weak model] in model?.pluginAuthenticationFailed(connection) })
    presentation.plugins[key] = plugin
    presentation.pluginTarget = plugin
  }

  @ViewBuilder private var nodeSettings: some View {
    if model.allowsNodeSelection {
      HStack {
        Text(model.savedNodePath == nil ? "Node.js 24+" : "已保存 Node 路径")
          .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textPrimary)
        Spacer()
        SettingsActionButton(model.savedNodePath == nil ? "选择 Node.js…" : "更换 Node.js…") {
          let panel = NSOpenPanel()
          panel.canChooseDirectories = false
          panel.canChooseFiles = true
          panel.allowsMultipleSelection = false
          panel.showsHiddenFiles = true
          panel.message = "选择已安装的 Node.js 24+ 可执行文件；验证后将保存此路径。"
          if panel.runModal() == .OK, let path = panel.url?.path {
            Task { await model.selectNode(path) }
          }
        }.disabled(model.localBusy)
      }
      if let path = model.savedNodePath {
        Text(path).font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
          .lineLimit(2).textSelection(.enabled)
      }
    }
  }

  private var directory: some View {
    SettingsCard {
      VStack(alignment: .leading, spacing: 12) {
        switch model.phase {
        case .unconfigured:
          note("连接云端后查看已接入的机器", symbol: "network")
        case .loading:
          HStack(spacing: 8) {
            SpinnerArc(size: 12)
            Text("正在读取机器…").font(Theme.TypeScale.note)
          }
        case .failed(let error):
          note(error.localizedDescription, symbol: "exclamationmark.triangle")
        case .ready:
          if model.machines.isEmpty { note("尚未接入机器", symbol: "desktopcomputer") }
          if !model.canIssue { note("云端尚未配置机器凭据签发", symbol: "key") }
        }
        ForEach(model.machines) { row in
          HStack(alignment: .top, spacing: 12) {
            Image(systemName: "desktopcomputer").font(.system(size: 18))
              .foregroundStyle(Theme.Palette.textSecondary).frame(width: 30)
            VStack(alignment: .leading, spacing: 5) {
              Text(row.machine.name).font(.system(size: 15, weight: .medium))
                .foregroundStyle(Theme.Palette.textPrimary)
              Label(row.statusText, systemImage: row.online ? "checkmark.circle" : "circle.dotted")
                .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
              Text(row.id).font(Theme.TypeScale.mono).foregroundStyle(Theme.Palette.textSecondary)
              if let error = model.operationErrors[row.id] {
                Label(error, systemImage: "exclamationmark.triangle")
                  .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.destructive)
                  .fixedSize(horizontal: false, vertical: true)
              }
              if case .observed(let status) = row.observation, let version = status.agentVersion {
                Text("\(status.online ? "Agent" : "上次报告") \(version)")
                  .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
                if let observed = status.observedAt {
                  Text("能力报告：\(observed)").font(Theme.TypeScale.note).foregroundStyle(
                    Theme.Palette.textSecondary)
                }
              }
              if case .observed(let status) = row.observation,
                let files = status.capabilities?.files
              {
                Text(
                  files.state == "ready"
                    ? "文件 · \(files.grants.filter(\.available).count) 个可用授权目录" : "文件授权状态未知"
                )
                .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
              }
              HStack {
                Text(herdrLabel(row)).font(Theme.TypeScale.note).foregroundStyle(
                  Theme.Palette.textSecondary)
                SettingsActionButton("Herdr 设置…") { openHerdr(row) }.disabled(
                  !model.canManage || !row.machine.enabled)
              }
            }
            Spacer(minLength: 6)
            Menu {
              Button("重命名") {
                model.renameText = row.machine.name
                model.renameTarget = row.id
              }
              if row.machine.enabled {
                Button("停用接入", role: .destructive) { model.revokeTarget = row.id }
              }
            } label: {
              Image(systemName: "ellipsis").frame(width: 28, height: 28)
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden)
            .fixedSize().disabled(!model.canManage)
            .accessibilityLabel("管理 \(row.machine.name)")
          }
          .frame(minHeight: Theme.Metric.settingsDeviceRowHeight)
          if row.id != model.machines.last?.id { Divider().overlay(Theme.Palette.line) }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.vertical, 16)
    }
  }

  private func herdrLabel(_ row: MachineRow) -> String {
    guard row.online, case .observed(let status) = row.observation else { return "Herdr · 状态未知" }
    return "Herdr · \(status.capabilities?.herdr?.label ?? "尚未检测")"
  }

  private func note(_ text: String, symbol: String) -> some View {
    Label(text, systemImage: symbol).font(Theme.TypeScale.note)
      .foregroundStyle(Theme.Palette.textSecondary).fixedSize(horizontal: false, vertical: true)
  }
}
