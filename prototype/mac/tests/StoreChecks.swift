import Foundation

@main
struct StoreChecks {
    private static func check(_ condition: Bool, _ description: String) throws {
        guard condition else { throw StoreError.message(description) }
    }

    private static func expectFailure(_ description: String, _ operation: () throws -> Void) throws {
        do { try operation() } catch { return }
        throw StoreError.message(description)
    }

    static func main() throws {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("mindmapper-mac-store-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: temporary) }

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

        try FileManager.default.removeItem(at: store.libraryURL)
        try expectFailure("External deletion should not be overwritten.") { try store.save(second) }
        try check(!FileManager.default.fileExists(atPath: store.libraryURL.path), "The stale save recreated a removed workspace.")
        try check(store.load() == nil, "An explicit load should accept the empty state.")
        try store.save(first)

        let corrupt = Data([0xff, 0xfe])
        try corrupt.write(to: store.libraryURL)
        try expectFailure("An unreadable save should fail to load.") { _ = try store.load() }
        try expectFailure("An unreadable save should not be overwritten.") { try store.save(first) }
        try check(Data(contentsOf: store.libraryURL) == corrupt, "The original unreadable data must be retained.")
        print("Mac store checks passed: reopen, prior revision, stale writes, no-op saves, schema, byte limit, external deletion, corrupt data.")
    }
}
