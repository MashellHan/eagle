import Foundation

/// How usage numbers read on screen: short tokens (`12.3k`) and a cost that never shows a
/// bare zero when a provider reports nothing.
public enum UsageFormat {
  public static func tokens(_ value: Int) -> String {
    if value < 1_000 { return String(value) }
    if value < 1_000_000 { return String(format: "%.1fk", Double(value) / 1_000) }
    return String(format: "%.1fM", Double(value) / 1_000_000)
  }

  public static func cost(_ usd: Double?) -> String? {
    guard let usd else { return nil }
    if usd == 0 { return "$0" }
    if usd < 0.01 { return "<$0.01" }
    return String(format: "$%.2f", usd)
  }

  /// `10-21`: a day in the chart's own short form.
  public static func shortDay(_ day: String) -> String {
    let parts = day.split(separator: "-")
    guard parts.count == 3 else { return day }
    return "\(parts[1])-\(parts[2])"
  }
}
