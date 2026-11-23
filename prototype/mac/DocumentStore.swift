import CoreFoundation
import CryptoKit
import Foundation

enum StoreError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        if case .message(let text) = self { return text }
        return nil
    }
}

/// The web model validates board contents. The native store checks the workspace
/// envelope and protects the last acknowledged revision on disk.
final class DocumentStore {
    static let maximumBytes = 20 * 1024 * 1024
    static let workspaceFormat = "mindmapper.workspace"
    static let workspaceVersion = 1

    let directory: URL
    var libraryURL: URL { directory.appendingPathComponent("Library.json") }
    var backupURL: URL { directory.appendingPathComponent("Library.previous.json") }

    private var expectedDigest: SHA256.Digest?
    private var loaded = false

    init(directory: URL) {
        self.directory = directory
    }

    private func prepareDirectory() throws {
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
    }

    private func coordinated(write: Bool, operation: (URL) throws -> Void) throws {
        let coordinator = NSFileCoordinator()
        var coordinationError: NSError?
        var operationError: Error?
        let access: (URL) -> Void = { url in
            do { try operation(url) } catch { operationError = error }
        }
        if write {
            coordinator.coordinate(writingItemAt: libraryURL, options: .forReplacing, error: &coordinationError, byAccessor: access)
        } else {
            coordinator.coordinate(readingItemAt: libraryURL, options: [], error: &coordinationError, byAccessor: access)
        }
        if let error = operationError ?? coordinationError { throw error }
    }

    private static func readBytes(at url: URL) throws -> Data {
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true else {
            throw StoreError.message("Choose a map or library file.")
        }
        guard values.fileSize ?? 0 <= maximumBytes else {
            throw StoreError.message("The file exceeds the 20 MB limit.")
        }
        let bytes = try Data(contentsOf: url)
        guard bytes.count <= maximumBytes else {
            throw StoreError.message("The file exceeds the 20 MB limit.")
        }
        return bytes
    }

    static func readText(at url: URL) throws -> String {
        let bytes = try readBytes(at: url)
        guard let text = String(data: bytes, encoding: .utf8) else {
            throw StoreError.message("The file is not readable UTF-8 text.")
        }
        return text
    }

    private static func validateWorkspace(_ bytes: Data) throws {
        guard
            let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
            object["format"] as? String == workspaceFormat,
            let version = object["version"] as? NSNumber,
            CFGetTypeID(version) != CFBooleanGetTypeID(),
            version.doubleValue == Double(workspaceVersion),
            let activeID = object["activeBoardId"] as? String,
            let boards = object["boards"] as? [[String: Any]],
            !boards.isEmpty
        else {
            throw StoreError.message("This file is not a Phase 3 workspace.")
        }
        let identifiers = boards.compactMap { $0["id"] as? String }.filter { !$0.isEmpty }
        let uniqueIDs = Set(identifiers)
        guard uniqueIDs.count == boards.count, uniqueIDs.contains(activeID) else {
            throw StoreError.message("The workspace board list is incomplete or inconsistent.")
        }
    }

    func load() throws -> String? {
        loaded = false
        try prepareDirectory()
        var text: String?
        try coordinated(write: false) { url in
            guard FileManager.default.fileExists(atPath: url.path) else {
                expectedDigest = nil
                return
            }
            let bytes = try Self.readBytes(at: url)
            guard let decoded = String(data: bytes, encoding: .utf8) else {
                throw StoreError.message("The saved workspace is not readable UTF-8 text.")
            }
            try Self.validateWorkspace(bytes)
            text = decoded
            expectedDigest = SHA256.hash(data: bytes)
        }
        loaded = true
        return text
    }

    func save(_ text: String) throws {
        guard loaded else { throw StoreError.message("Open the workspace before saving it.") }
        let bytes = Data(text.utf8)
        guard bytes.count <= Self.maximumBytes else {
            throw StoreError.message("The workspace exceeds the 20 MB limit. Export a board to make a separate copy.")
        }
        try Self.validateWorkspace(bytes)
        try prepareDirectory()
        try coordinated(write: true) { url in
            let previous = FileManager.default.fileExists(atPath: url.path) ? try Self.readBytes(at: url) : nil
            let actualDigest = previous.map { SHA256.hash(data: $0) }
            guard actualDigest == expectedDigest else {
                throw StoreError.message("The workspace changed on disk. Export your unsaved board, then reopen the app.")
            }
            // An unchanged save leaves the previous revision available for recovery.
            guard previous != bytes else { return }
            if let previous {
                try previous.write(to: backupURL, options: .atomic)
            }
            try bytes.write(to: url, options: .atomic)
            expectedDigest = SHA256.hash(data: bytes)
        }
    }
}
