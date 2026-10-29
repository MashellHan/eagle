import SwiftUI

/// Transparent header band shared by the three columns. It only fixes the
/// height grid so the groups line up; each column paints its own background
/// behind it.
public struct HeaderRow<Content: View>: View {
  private let content: Content

  public init(@ViewBuilder content: () -> Content) {
    self.content = content()
  }

  public var body: some View {
    content
      .frame(height: Theme.Metric.headerBandHeight, alignment: .top)
      .padding(.top, Theme.Metric.headerTopInset)
      .frame(height: Theme.Metric.headerHeight, alignment: .top)
  }
}
