import Foundation

@main
struct StoreChecks {
    private static func check(_ condition: Bool, _ description: String) throws {
        guard condition else { throw StoreError.message(description) }
    }

    private static func expectFailure(_ description: String, containing message: String? = nil, _ operation: () throws -> Void) throws {
        do { try operation() } catch {
            if let message { try check(error.localizedDescription.contains(message), description) }
            return
        }
        throw StoreError.message(description)
    }

    static func main() throws {
        let files = FileManager.default
        let sandbox = files.temporaryDirectory.appendingPathComponent("mindmapper-mac-store-" + UUID().uuidString)
        defer { try? files.removeItem(at: sandbox) }
        let temporary = sandbox.appendingPathComponent("Workspace")

        let first = #"{"format":"mindmapper.workspace","version":1,"activeBoardId":"a","boards":[{"id":"a","title":"First"}]}"#
        let second = #"{"format":"mindmapper.workspace","version":1,"activeBoardId":"a","boards":[{"id":"a","title":"Second"}]}"#
        let store = DocumentStore(directory: temporary)
        try expectFailure("A store without a load must reject writes.") { try store.save(first) }
        try check(store.load() == nil, "An empty directory should load as a new workspace.")
        try store.save(first)

        let other = DocumentStore(directory: temporary)
        try check(other.load() == first, "A new store should reopen the first revision.")
        try store.save(second)
        try check(DocumentStore.readText(at: store.backupURL) == first, "Changing the workspace should keep the previous revision.")
        try expectFailure("A stale writer should not overwrite newer work.") { try other.save(first) }
        try store.save(second)
        try check(DocumentStore.readText(at: store.backupURL) == first, "A no-op save should keep the existing backup.")

        let wrongFormat = second.replacingOccurrences(of: "mindmapper.workspace", with: "mindmapper.board")
        let unknownVersion = second.replacingOccurrences(of: #""version":1"#, with: #""version":2"#)
        let booleanVersion = second.replacingOccurrences(of: #""version":1"#, with: #""version":true"#)
        let wrongActive = second.replacingOccurrences(of: #""activeBoardId":"a""#, with: #""activeBoardId":"b""#)
        let duplicateID = second.replacingOccurrences(of: #""title":"Second"}]"#, with: #""title":"Second"},{"id":"a"}]"#)
        for invalid in ["invalid", wrongFormat, unknownVersion, booleanVersion, wrongActive, duplicateID] {
            try expectFailure("Invalid data should not replace the workspace.") { try store.save(invalid) }
        }
        try expectFailure("The byte limit should include multi-byte Unicode.") {
            try store.save(String(repeating: "é", count: DocumentStore.maximumBytes / 2 + 1))
        }
        try check(store.load() == second, "Invalid saves must leave the active revision intact.")
        try check(DocumentStore.readText(at: store.backupURL) == first, "Invalid saves must leave recovery intact.")

        let third = second.replacingOccurrences(of: "Second", with: "Third")
        var diskFull = true
        var failedStaging: URL?
        let limited = DocumentStore(directory: temporary) { bytes, target in
            if diskFull {
                failedStaging = target.deletingLastPathComponent()
                try bytes.prefix(8).write(to: target)
                throw CocoaError(.fileWriteOutOfSpace)
            }
            try bytes.write(to: target, options: .atomic)
        }
        try check(limited.load() == second, "The disk-full store should start from the current revision.")
        do {
            try limited.save(third)
            throw StoreError.message("An out-of-space save must report failure.")
        } catch let error as CocoaError where error.code == .fileWriteOutOfSpace {}
        try check(DocumentStore.readText(at: store.libraryURL) == second, "A partial staged write changed the workspace.")
        try check(DocumentStore.readText(at: store.backupURL) == first, "A partial staged write changed the recovery copy.")
        try check(failedStaging.map { !files.fileExists(atPath: $0.path) } == true, "A failed write left its staging files on disk.")
        diskFull = false
        try limited.save(third)
        try check(limited.load() == third, "Retry after clearing space did not write the pending revision.")
        try check(DocumentStore.readText(at: store.backupURL) == second, "A successful retry did not retain the prior revision.")

        let movedDirectory = sandbox.appendingPathComponent("Moved workspace")
        try files.moveItem(at: temporary, to: movedDirectory)
        try expectFailure("A moved workspace folder should reject saves.", containing: "folder is missing") { try limited.save(first) }
        try check(!files.fileExists(atPath: temporary.path), "Saving recreated a moved workspace folder.")
        try files.moveItem(at: movedDirectory, to: temporary)

        let movedLibrary = sandbox.appendingPathComponent("Moved Library.json")
        try files.moveItem(at: store.libraryURL, to: movedLibrary)
        try expectFailure("A moved workspace should not be overwritten.") { try limited.save(third) }
        try check(!files.fileExists(atPath: store.libraryURL.path), "The stale save recreated a missing workspace.")
        try expectFailure("A missing workspace with a recovery copy must offer recovery, not start blank.", containing: "Library.previous.json") {
            _ = try store.load()
        }
        try files.copyItem(at: store.backupURL, to: store.libraryURL)
        try check(store.load() == second, "Restoring a copy of the previous revision did not reopen it.")
        try check(DocumentStore.readText(at: movedLibrary) == third, "Recovery replaced the moved workspace.")
        try check(DocumentStore.readText(at: store.backupURL) == second, "Recovery rewrote its source.")

        let futureBytes = Data(unknownVersion.utf8)
        try futureBytes.write(to: store.libraryURL)
        try expectFailure("A future workspace version should ask for newer Mind Mapper.", containing: "newer version") { _ = try store.load() }
        try expectFailure("A future workspace should be left intact.") { try store.save(first) }
        try check(Data(contentsOf: store.libraryURL) == futureBytes, "The future workspace was replaced.")

        let corrupt = Data([0xff, 0xfe])
        try corrupt.write(to: store.libraryURL)
        try expectFailure("An unreadable save should fail to load.") { _ = try store.load() }
        try expectFailure("An unreadable save should not be overwritten.") { try store.save(first) }
        try check(Data(contentsOf: store.libraryURL) == corrupt, "The original unreadable data must be retained.")
        print("Mac store checks passed: reopen, stale writer, no-op, byte limit, partial disk-full write and retry, moved workspace, recovery restore, corrupt and future workspace.")
    }
}
