import EagleDesign
import SwiftUI

/// Shared device directory, independent of the selected Bot's identity.
public struct DeviceInspectorView: View {
  @ObservedObject private var model: DeviceSettingsViewModel
  private let onManage: () -> Void

  public init(model: DeviceSettingsViewModel = .shared, onManage: @escaping () -> Void) {
    self.model = model
    self.onManage = onManage
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: Theme.Metric.panelSectionBodyGap) {
      PanelSectionHeader(symbolName: "desktopcomputer", title: "共享设备")
      if let directory = model.directory, !directory.devices.isEmpty {
        ForEach(directory.devices) { device in
          DeviceSummaryView(
            device: device, isLocal: device.deviceId == directory.localDeviceId,
            localReady: model.localReady, stale: model.directoryIsStale, compact: true)
        }
      } else {
        Text(model.enabled ? "还没有读到设备目录" : "设备服务已停用")
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.textMuted)
      }
      Text("所有 Bot 共用同一设备群")
        .font(Theme.TypeScale.pill)
        .foregroundStyle(Theme.Palette.textMuted)
      TextAction("管理设备", action: onManage)
        .frame(maxWidth: .infinity)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .task {
      while !Task.isCancelled {
        await model.startIfNeeded()
        await model.refresh()
        do { try await Task.sleep(for: .seconds(5)) } catch { return }
      }
    }
  }
}
