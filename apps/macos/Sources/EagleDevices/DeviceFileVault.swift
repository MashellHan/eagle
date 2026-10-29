import CryptoKit
import Darwin
import Foundation

/// Helper-owned credentials. No Keychain lookup, migration or fallback occurs here.
public struct DeviceFileVault: DeviceIdentityVault {
  public static var defaultDirectory: URL {
    URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
      .appendingPathComponent(".eagle-device-identities", isDirectory: true)
  }
  private let directory: URL
  private let maximumSize = 4096

  public init(directory: URL = Self.defaultDirectory) {
    self.directory = directory
  }

  public func read(account: String) throws -> Data? {
    guard let parent = try openDirectory(create: false) else { return nil }
    defer { close(parent) }
    let file = openat(parent, filename(account), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    if file < 0 {
      if errno == ENOENT { return nil }
      throw storageError()
    }
    defer { close(file) }
    var info = stat()
    guard fstat(file, &info) == 0 else { throw DeviceIdentityError.storageUnavailable }
    guard info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1,
      info.st_uid == getuid(), info.st_mode & 0o7777 == 0o600
    else {
      throw DeviceIdentityError.insecureStorage
    }
    try requireNoExtendedACL(file)
    guard info.st_size > 0, info.st_size <= maximumSize else {
      throw DeviceIdentityError.corruptIdentity
    }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: maximumSize + 1)
    while true {
      let count = buffer.withUnsafeMutableBytes { Darwin.read(file, $0.baseAddress, $0.count) }
      if count < 0 {
        if errno == EINTR { continue }
        throw DeviceIdentityError.storageUnavailable
      }
      if count == 0 { break }
      data.append(contentsOf: buffer.prefix(count))
      guard data.count <= maximumSize else { throw DeviceIdentityError.corruptIdentity }
    }
    guard data.count == info.st_size else { throw DeviceIdentityError.corruptIdentity }
    return data
  }

  public func insert(_ data: Data, account: String) throws -> Bool {
    guard !data.isEmpty, data.count <= maximumSize else {
      throw DeviceIdentityError.corruptIdentity
    }
    guard let parent = try openDirectory(create: true) else {
      throw DeviceIdentityError.storageUnavailable
    }
    defer { close(parent) }
    let temporary = ".identity-" + UUID().uuidString.lowercased()
    let file = openat(
      parent, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard file >= 0 else { throw storageError() }
    defer {
      close(file)
      unlinkat(parent, temporary, 0)
    }
    guard fchmod(file, 0o600) == 0 else { throw DeviceIdentityError.storageUnavailable }
    try requireNoExtendedACL(file)
    try data.withUnsafeBytes { bytes in
      var offset = 0
      while offset < bytes.count {
        let count = Darwin.write(
          file, bytes.baseAddress?.advanced(by: offset), bytes.count - offset)
        if count < 0 {
          if errno == EINTR { continue }
          throw DeviceIdentityError.storageUnavailable
        }
        guard count > 0 else { throw DeviceIdentityError.storageUnavailable }
        offset += count
      }
    }
    guard fsync(file) == 0 else { throw DeviceIdentityError.storageUnavailable }
    if renameatx_np(parent, temporary, parent, filename(account), UInt32(RENAME_EXCL)) != 0 {
      if errno == EEXIST { return false }
      throw storageError()
    }
    guard fsync(parent) == 0 else { throw DeviceIdentityError.storageUnavailable }
    return true
  }

  private func filename(_ account: String) -> String {
    SHA256.hash(data: Data(account.utf8)).map { String(format: "%02x", $0) }.joined() + ".json"
  }

  private func openDirectory(create: Bool) throws -> Int32? {
    guard directory.isFileURL, directory.path.hasPrefix("/") else {
      throw DeviceIdentityError.insecureStorage
    }
    let components = directory.pathComponents.filter { $0 != "/" }
    guard !components.isEmpty, !components.contains("."), !components.contains("..") else {
      throw DeviceIdentityError.insecureStorage
    }
    var current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    guard current >= 0 else { throw DeviceIdentityError.storageUnavailable }
    do {
      for (index, component) in components.enumerated() {
        let final = index == components.count - 1
        var next = openat(current, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        if next < 0, errno == ENOENT, final, create {
          guard mkdirat(current, component, 0o700) == 0 || errno == EEXIST else {
            throw storageError()
          }
          next = openat(current, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        }
        if next < 0 {
          if errno == ENOENT, final, !create {
            close(current)
            return nil
          }
          throw storageError()
        }
        close(current)
        current = next
      }
      var info = stat()
      guard fstat(current, &info) == 0 else { throw DeviceIdentityError.storageUnavailable }
      guard info.st_uid == getuid(), info.st_mode & 0o7777 == 0o700 else {
        throw DeviceIdentityError.insecureStorage
      }
      try requireNoExtendedACL(current)
      return current
    } catch {
      close(current)
      throw error
    }
  }

  private func requireNoExtendedACL(_ descriptor: Int32) throws {
    guard let acl = acl_get_fd_np(descriptor, ACL_TYPE_EXTENDED) else {
      // Darwin uses ENOENT when this pinned descriptor has no extended ACL.
      if errno == ENOENT { return }
      throw DeviceIdentityError.storageUnavailable
    }
    defer { acl_free(UnsafeMutableRawPointer(acl)) }
    guard acl_valid(acl) == 0 else { throw DeviceIdentityError.storageUnavailable }
    var entry: acl_entry_t?
    errno = 0
    let result = acl_get_entry(acl, Int32(ACL_FIRST_ENTRY.rawValue), &entry)
    if result == 0 { throw DeviceIdentityError.insecureStorage }
    // Darwin reports EINVAL at the end of a valid ACL, including an empty one.
    guard result == -1, errno == EINVAL else {
      throw DeviceIdentityError.storageUnavailable
    }
  }

  private func storageError() -> DeviceIdentityError {
    [ELOOP, ENOTDIR].contains(errno) ? .insecureStorage : .storageUnavailable
  }
}
