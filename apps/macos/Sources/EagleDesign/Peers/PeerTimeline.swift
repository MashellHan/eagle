import Foundation

/// How the dialog names a moment: "今天 19:30" for today, "10-28 19:30" otherwise. One place, so a
/// divider and a row never disagree about what "today" means.
public enum PeerTimeline {
  public static func label(_ date: Date) -> String { label(date, now: Date()) }

  public static func label(_ date: Date, now: Date) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat =
      Calendar.current.isDate(date, inSameDayAs: now) ? "'今天' HH:mm" : "MM-dd HH:mm"
    return formatter.string(from: date)
  }

  /// The daemon's ISO instant, read the way every other surface reads it.
  public static func date(_ iso: String) -> Date? {
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return parser.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
  }
}
