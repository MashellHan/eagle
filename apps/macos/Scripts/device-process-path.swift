import Darwin
import Foundation

guard CommandLine.arguments.count == 2, let pid = Int32(CommandLine.arguments[1]), pid > 0 else {
  exit(64)
}
// libproc's PROC_PIDPATHINFO_MAXSIZE macro is not imported by every Swift SDK.
var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { exit(1) }
print(String(decoding: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self))
