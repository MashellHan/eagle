import Darwin
import Foundation
import Testing

@testable import EagleDevices

@Suite("Device private file identity")
struct DeviceFileVaultTests {
  private func fixture() throws -> URL {
    let canonical = try #require(realpath(FileManager.default.temporaryDirectory.path, nil))
    defer { free(canonical) }
    let root = URL(fileURLWithPath: String(cString: canonical), isDirectory: true)
      .appendingPathComponent("device-file-vault-" + UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(
      at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    return root
  }
  private func identityFile(_ directory: URL) throws -> URL {
    try #require(
      FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        .first { $0.pathExtension == "json" })
  }
  private func load(_ directory: URL, profile: String = "device-candidate") throws -> DeviceIdentity
  {
    try DeviceIdentity.loadOrCreate(profile: profile, vault: DeviceFileVault(directory: directory))
  }
  private func extendedACL(_ path: URL) throws -> String {
    let acl = try #require(acl_get_file(path.path, ACL_TYPE_EXTENDED))
    defer { acl_free(UnsafeMutableRawPointer(acl)) }
    var entry: acl_entry_t?
    try #require(acl_get_entry(acl, Int32(ACL_FIRST_ENTRY.rawValue), &entry) == 0)
    let text = try #require(acl_to_text(acl, nil))
    defer { acl_free(text) }
    return String(cString: text)
  }
  private func grant(_ permissions: String, to path: URL, mode: Int) throws -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/chmod")
    process.arguments = ["+a", "everyone allow " + permissions, path.path]
    try process.run()
    process.waitUntilExit()
    try #require(process.terminationStatus == 0)
    let attributes = try FileManager.default.attributesOfItem(atPath: path.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == mode)
    return try extendedACL(path)
  }

  @Test("real private storage persists one identity and separates profiles")
  func persists() throws {
    let root = try fixture()
    defer { try? FileManager.default.removeItem(at: root) }
    let directory = root.appendingPathComponent("identities")
    let first = try load(directory)
    let second = try load(directory)
    #expect(first.deviceId == second.deviceId)
    #expect(first.publicKey == second.publicKey)
    #expect(UUID(uuidString: first.deviceId) != nil)
    #expect(first.deviceId == first.deviceId.lowercased())
    let other = try load(directory, profile: "device-release")
    #expect(other.deviceId != first.deviceId)
    #expect(other.publicKey != first.publicKey)
    for path in [directory, try identityFile(directory)] {
      let attributes = try FileManager.default.attributesOfItem(atPath: path.path)
      #expect((attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid())
      #expect(
        (attributes[.posixPermissions] as? NSNumber)?.intValue
          == (path == directory ? 0o700 : 0o600))
    }
  }

  @Test("concurrent real-file creators converge without exposing a partial record")
  func concurrentCreation() async throws {
    let root = try fixture()
    defer { try? FileManager.default.removeItem(at: root) }
    let directory = root.appendingPathComponent("identities")
    let identities = try await withThrowingTaskGroup(of: DeviceIdentity.self) { group in
      for _ in 0..<24 {
        group.addTask { try load(directory) }
      }
      var values: [DeviceIdentity] = []
      for try await identity in group { values.append(identity) }
      return values
    }
    #expect(Set(identities.map(\.deviceId)).count == 1)
    #expect(Set(identities.map(\.publicKey)).count == 1)
    #expect(
      try FileManager.default.contentsOfDirectory(atPath: directory.path).count == 1)
  }

  @Test("unsafe file or directory permissions fail closed without replacement")
  func rejectsPermissions() throws {
    let root = try fixture()
    defer { try? FileManager.default.removeItem(at: root) }
    let directory = root.appendingPathComponent("identities")
    _ = try load(directory)
    let file = try identityFile(directory)
    let original = try Data(contentsOf: file)
    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
    #expect(throws: DeviceIdentityError.insecureStorage) { try load(directory) }
    #expect(try Data(contentsOf: file) == original)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: directory.path)
    #expect(throws: DeviceIdentityError.insecureStorage) { try load(directory) }
    #expect(throws: DeviceIdentityError.insecureStorage) {
      try load(directory, profile: "new-profile")
    }
    #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).count == 1)
  }

  @Test("an explicit file ACL is rejected despite mode 0600 without changing the identity")
  func rejectsFileACL() throws {
    let root = try fixture()
    defer { try? FileManager.default.removeItem(at: root) }
    let directory = root.appendingPathComponent("identities")
    _ = try load(directory)
    let file = try identityFile(directory)
    let original = try Data(contentsOf: file)
    let acl = try grant("read", to: file, mode: 0o600)
    #expect(throws: DeviceIdentityError.insecureStorage) { try load(directory) }
    #expect(try Data(contentsOf: file) == original)
    #expect(try extendedACL(file) == acl)
    #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).count == 1)
  }

  @Test("directory ACLs including file inheritance reject reads and creation at mode 0700")
  func rejectsDirectoryACL() throws {
    let root = try fixture()
    defer { try? FileManager.default.removeItem(at: root) }
    let directory = root.appendingPathComponent("identities")
    _ = try load(directory)
    let file = try identityFile(directory)
    let original = try Data(contentsOf: file)
    let acl = try grant("read,search,file_inherit", to: directory, mode: 0o700)
    #expect(throws: DeviceIdentityError.insecureStorage) { try load(directory) }
    #expect(throws: DeviceIdentityError.insecureStorage) {
      try load(directory, profile: "new-profile")
    }
    #expect(try Data(contentsOf: file) == original)
    #expect(try extendedACL(directory) == acl)
    #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).count == 1)
  }

  @Test("inherited directory ACLs reject creation before any identity is written")
  func rejectsInheritedDirectoryACL() throws {
    let root = try fixture()
    defer { try? FileManager.default.removeItem(at: root) }
    let originalDirectory = root.appendingPathComponent("original")
    let originalIdentity = try load(originalDirectory)
    let originalFile = try identityFile(originalDirectory)
    let original = try Data(contentsOf: originalFile)
    _ = try grant("read,file_inherit,directory_inherit", to: root, mode: 0o700)
    let directory = root.appendingPathComponent("inherited")
    #expect(throws: DeviceIdentityError.insecureStorage) { try load(directory) }
    #expect(try extendedACL(directory).contains("inherited"))
    let attributes = try FileManager.default.attributesOfItem(atPath: directory.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o700)
    #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty)
    #expect(try Data(contentsOf: originalFile) == original)
    #expect(try load(originalDirectory).deviceId == originalIdentity.deviceId)
  }

  @Test("an inherited record ACL remains unsafe after moving into a private directory")
  func rejectsInheritedFileACL() throws {
    let root = try fixture()
    defer { try? FileManager.default.removeItem(at: root) }
    let originalDirectory = root.appendingPathComponent("original")
    let identity = try load(originalDirectory)
    let originalFile = try identityFile(originalDirectory)
    let original = try Data(contentsOf: originalFile)
    let staging = root.appendingPathComponent("staging")
    let directory = root.appendingPathComponent("identities")
    for path in [staging, directory] {
      try FileManager.default.createDirectory(
        at: path, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    }
    _ = try grant("read,file_inherit,only_inherit", to: staging, mode: 0o700)
    let inheritedFile = staging.appendingPathComponent(originalFile.lastPathComponent)
    try #require(
      FileManager.default.createFile(
        atPath: inheritedFile.path, contents: original, attributes: [.posixPermissions: 0o600]))
    let file = directory.appendingPathComponent(originalFile.lastPathComponent)
    try FileManager.default.moveItem(at: inheritedFile, to: file)
    let acl = try extendedACL(file)
    #expect(acl.contains("inherited"))
    let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    #expect(throws: DeviceIdentityError.insecureStorage) { try load(directory) }
    #expect(try Data(contentsOf: file) == original)
    #expect(try extendedACL(file) == acl)
    #expect(try load(originalDirectory).deviceId == identity.deviceId)
  }

  @Test("corrupt, empty and oversized files never create another identity")
  func rejectsCorruption() throws {
    let root = try fixture()
    defer { try? FileManager.default.removeItem(at: root) }
    let directory = root.appendingPathComponent("identities")
    _ = try load(directory)
    let file = try identityFile(directory)
    for data in [Data(), Data("invalid".utf8), Data(repeating: 65, count: 4097)] {
      try data.write(to: file)
      #expect(throws: DeviceIdentityError.corruptIdentity) { try load(directory) }
      #expect(try Data(contentsOf: file) == data)
    }
  }

  @Test("symlinked directories and files, hardlinks and non-files are rejected")
  func rejectsLinks() throws {
    let root = try fixture()
    defer { try? FileManager.default.removeItem(at: root) }
    let directory = root.appendingPathComponent("identities")
    _ = try load(directory)
    let file = try identityFile(directory)
    let alias = root.appendingPathComponent("alias")
    try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: directory)
    #expect(throws: DeviceIdentityError.insecureStorage) { try load(alias) }
    #expect(throws: DeviceIdentityError.insecureStorage) {
      try load(alias.appendingPathComponent("child"))
    }
    let external = root.appendingPathComponent("external")
    try FileManager.default.moveItem(at: file, to: external)
    try FileManager.default.createSymbolicLink(at: file, withDestinationURL: external)
    #expect(throws: DeviceIdentityError.insecureStorage) { try load(directory) }
    try FileManager.default.removeItem(at: file)
    try FileManager.default.linkItem(at: external, to: file)
    #expect(throws: DeviceIdentityError.insecureStorage) { try load(directory) }
    try FileManager.default.removeItem(at: file)
    #expect(mkfifo(file.path, 0o600) == 0)
    #expect(throws: DeviceIdentityError.insecureStorage) { try load(directory) }
  }
}
