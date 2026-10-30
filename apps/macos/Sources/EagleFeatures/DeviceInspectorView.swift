import EagleDesign
import SwiftUI

/// The live computer list: the shared device model, drawn as the inspector's compact rows.
public struct DeviceInspectorView: View {
  @ObservedObject private var model: DeviceSettingsViewModel
  private let onManage: () -> Void

  public init(model: DeviceSettingsViewModel = .shared, onManage: @escaping () -> Void) {
    self.model = model
    self.onManage = onManage
  }

  public var body: some View {
    DeviceInspectorList(
      entries: (model.directory?.devices ?? []).map { device in
        DeviceInspectorEntry(
          id: device.deviceId,
          name: device.name,
          isLocal: device.deviceId == model.directory?.localDeviceId,
          online: device.online,
          policy: model.policy(for: device)?.mode.title ?? "策略未知"
        )
      },
      enabled: model.enabled,
      stale: model.directoryIsStale,
      onManage: onManage
    )
    .task { await model.observe() }
  }
}
