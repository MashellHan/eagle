import BotsCore
import BotsTransport
import Foundation

/// Eagle composes the saved deployment with the independent Bots authority API.
@MainActor enum BotRemoteAccess {
  static func port(settings: BotsSettings) throws -> RemoteToolsHTTPClient {
    try RemoteToolsHTTPClient(
      baseURL: settings.baseURL, token: settings.readToken())
  }

  static func grant(
    bot: BotSummary, settings: BotsSettings, configuration: AppLaunchConfiguration = .current
  ) throws -> BotRemoteGrantModel {
    BotRemoteGrantModel(
      botID: bot.id, botTitle: bot.title, port: try port(settings: settings),
      helper: BotCredentialHelper.discover(environment: configuration.environment),
      vault: KeychainMachineCredentials(service: configuration.credentialsService),
      sharing: KeychainBotRemoteSharingStore(
        root: settings.rootURL, service: configuration.credentialsService),
      coordinator: configuration.coordinator,
      directory: { try await machineRows(connection: $0) })
  }

  static func machineRows(connection: MachineConnection) async throws -> [MachineRow] {
    let client = MachineHTTPClient(connection: connection)
    let directory = try await client.directory()
    return try await withThrowingTaskGroup(of: MachineRow.self) { group in
      for machine in directory.machines {
        group.addTask {
          guard machine.enabled else { return MachineRow(machine: machine) }
          do {
            let status = try await client.status(id: machine.id)
            return MachineRow(machine: machine, observation: .observed(status))
          } catch MachineAccessError.authentication {
            throw MachineAccessError.authentication
          } catch {
            return MachineRow(machine: machine)
          }
        }
      }
      var rows: [MachineRow] = []
      for try await row in group { rows.append(row) }
      return directory.machines.compactMap { machine in rows.first { $0.id == machine.id } }
    }
  }
}

extension MachineSettingsModel {
  public static func live(configuration: AppLaunchConfiguration = .current) -> MachineSettingsModel
  {
    let key = "eagle.machine-agent.nodePath"
    let selected = configuration.defaults.string(forKey: key)
    let settings = configuration.botsSettings
    let vault = KeychainMachineCredentials(service: configuration.credentialsService)
    let writer = BotSharedConnectionWriter(
      vault: vault,
      sharing: KeychainBotRemoteSharingStore(
        root: settings.rootURL, service: configuration.credentialsService),
      coordinator: configuration.coordinator,
      port: { try BotRemoteAccess.port(settings: settings) })
    return MachineSettingsModel(
      vault: vault, connectionWriter: writer,
      agent: LocalAgentService.discover(
        environment: configuration.environment, nodePreference: selected),
      nodeSelection: {
        LocalAgentService.discover(environment: configuration.environment, nodePreference: $0)
      },
      saveNode: { configuration.defaults.set($0, forKey: key) }, savedNodePath: selected)
  }
}
