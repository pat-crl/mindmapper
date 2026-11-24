import AppKit
import WebKit

@main
@MainActor
final class WebBridgeChecks: NSObject, NSApplicationDelegate {
    private let resourceRoot: URL
    private let temporary: URL
    private let legacyFixture: URL
    private let clipboard = NSPasteboard(name: .init("MindMapperChecks-" + UUID().uuidString))
    private var cancelSelection = false

    private init(resourceRoot: URL, temporary: URL, legacyFixture: URL) {
        self.resourceRoot = resourceRoot
        self.temporary = temporary
        self.legacyFixture = legacyFixture
    }

    static func main() {
        let arguments = CommandLine.arguments
        guard arguments.count == 4 else {
            fputs("Usage: WebBridgeChecks WEB_RESOURCE_ROOT TEMPORARY_DIRECTORY LEGACY_MAP\n", stderr)
            exit(2)
        }
        let delegate = WebBridgeChecks(
            resourceRoot: URL(fileURLWithPath: arguments[1], isDirectory: true),
            temporary: URL(fileURLWithPath: arguments[2], isDirectory: true),
            legacyFixture: URL(fileURLWithPath: arguments[3])
        )
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        app.delegate = delegate
        app.run()
        withExtendedLifetime(delegate) {}
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 40) {
            fputs("Native bridge checks timed out.\n", stderr)
            exit(124)
        }
        Task {
            do { try await runChecks(); exit(0) }
            catch { fputs(error.localizedDescription + "\n", stderr); exit(1) }
        }
    }

    private func check(_ condition: Bool, _ description: String) throws {
        guard condition else { throw StoreError.message(description) }
    }

    private func makeEditor(store: DocumentStore, window: NSWindow) -> WebEditor {
        let editor = WebEditor(resourceRoot: resourceRoot, store: store, ephemeral: true, pasteboard: clipboard) { [self] panel, _, selection in
            if cancelSelection {
                cancelSelection = false
                selection(nil)
            } else if panel is NSOpenPanel {
                selection(legacyFixture)
            } else {
                let ext = (panel.nameFieldStringValue as NSString).pathExtension
                selection(temporary.appendingPathComponent("Export." + ext))
            }
        }
        editor.didFail = { message in fputs("WebKit: " + message + "\n", stderr) }
        window.contentView = editor.webView
        editor.webView.frame = NSRect(origin: .zero, size: window.contentLayoutRect.size)
        editor.load()
        return editor
    }

    private func waitUntilReady(_ editor: WebEditor) async throws {
        for _ in 0..<80 {
            if let ready = try? await editor.webView.callAsyncJavaScript(
                "return window.MindMapperPrototype ? await window.MindMapperPrototype.ready : false;",
                contentWorld: .page
            ), ready as? Bool == true {
                return
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw StoreError.message("The bundled editor did not report ready.")
    }

    private func json(at url: URL) throws -> [String: Any] {
        guard let value = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] else {
            throw StoreError.message("Expected a JSON object in \(url.lastPathComponent).")
        }
        return value
    }

    private func boards(at url: URL) throws -> [[String: Any]] {
        guard let value = try json(at: url)["boards"] as? [[String: Any]], !value.isEmpty else {
            throw StoreError.message("Expected boards in the saved workspace.")
        }
        return value
    }

    private func runChecks() async throws {
        defer { clipboard.releaseGlobally() }
        let directory = temporary.appendingPathComponent("Native workspace", isDirectory: true)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let store = DocumentStore(directory: directory)
        let editor = makeEditor(store: store, window: window)
        try await waitUntilReady(editor)
        try check(editor.hasLoadedLibrary, "The editor did not load through the Mac file bridge.")
        _ = try await editor.perform("new")
        try await check(editor.perform("save") as? Bool == true, "A new board was not acknowledged by the Mac file store.")
        let beforeImport = try boards(at: store.libraryURL).count

        _ = try await editor.perform("open")
        try await check(editor.perform("save") as? Bool == true, "The imported map was not saved.")
        let afterImport = try boards(at: store.libraryURL)
        let oldMaps = try json(at: legacyFixture)["maps"] as? [[String: Any]] ?? []
        try check(!oldMaps.isEmpty && afterImport.count == beforeImport + oldMaps.count, "A legacy map did not become an added board.")

        cancelSelection = true
        _ = try await editor.perform("open")
        try await check(editor.perform("save") as? Bool == true, "The workspace could not save after cancelling import.")
        try check(boards(at: store.libraryURL).count == afterImport.count, "Cancelling import changed the workspace.")

        _ = try await editor.perform("example")
        try await check(editor.perform("save") as? Bool == true, "The mixed example board was not saved.")
        let populated = try json(at: store.libraryURL)
        let activeID = populated["activeBoardId"] as? String
        let allBoards = try boards(at: store.libraryURL)
        let active = allBoards.first { $0["id"] as? String == activeID }
        let types = Set((active?["objects"] as? [[String: Any]] ?? []).compactMap { $0["type"] as? String })
        try check(Set(["shape", "text", "stroke", "branch"]).isSubset(of: types), "The example board did not contain all four object types.")
        try check(!(active?["links"] as? [[String: Any]] ?? []).isEmpty, "The example board did not preserve its connector.")

        let updatedText = "Prototype note\nSecond line"
        let editedID = try await editor.webView.callAsyncJavaScript(
            """
            const object = document.querySelector('.object[data-type="shape"][data-locked="false"]');
            if (!object) throw new Error('No unlocked shape is available to edit.');
            object.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            const textEditor = document.querySelector('#object-editor');
            if (textEditor.hidden) throw new Error('Double click did not open the text editor.');
            textEditor.value = updatedText;
            textEditor.dispatchEvent(new Event('input', { bubbles: true }));
            textEditor.blur();
            return object.dataset.object;
            """,
            arguments: ["updatedText": updatedText],
            contentWorld: .page
        ) as? String
        try check(editedID != nil, "The native DOM edit did not select an object.")
        func currentShapeText() throws -> String? {
            let board = try boards(at: store.libraryURL).first { $0["id"] as? String == activeID }
            let objects = board?["objects"] as? [[String: Any]] ?? []
            return objects.first { $0["id"] as? String == editedID }?["text"] as? String
        }
        try await check(editor.perform("save") as? Bool == true, "The edited text did not save.")
        try check(currentShapeText() == updatedText, "The saved shape did not keep both lines.")
        _ = try await editor.perform("undo")
        try await check(editor.perform("save") as? Bool == true, "The workspace could not save after Undo.")
        try check(currentShapeText() != updatedText, "Undo did not revert the text edit.")
        _ = try await editor.perform("redo")
        try await check(editor.perform("save") as? Bool == true, "The workspace could not save after Redo.")
        try check(currentShapeText() == updatedText, "Redo did not restore the text edit.")

        _ = try await editor.perform("exportBoard")
        let exported = try json(at: temporary.appendingPathComponent("Export.mindmap"))
        try check(exported["id"] as? String == activeID, "Editable export did not save the active board.")
        _ = try await editor.perform("exportSVG")
        let svg = try String(contentsOf: temporary.appendingPathComponent("Export.svg"), encoding: .utf8)
        try check(svg.contains("<svg") && svg.contains("viewBox=") && svg.contains("<path") && svg.contains("Prototype note"),
                  "The native SVG export is missing vector paths or editable text.")
        cancelSelection = true
        _ = try await editor.perform("exportSVG")
        try check(String(contentsOf: temporary.appendingPathComponent("Export.svg"), encoding: .utf8) == svg,
                  "Cancelling export changed the prior export.")

        _ = try await editor.webView.callAsyncJavaScript(
            "document.activeElement?.blur(); return true;", contentWorld: .page
        )
        try await check(editor.perform("selectAll") as? Bool == true, "Select All did not select the example board.")
        try await check(editor.perform("copy") as? Bool == true, "The canvas could not copy to a scratch Mac pasteboard.")
        let copied = WebEditor.readClipboard(from: clipboard)
        try check(copied["selection"] != nil && copied["text"]?.contains("Prototype note") == true,
                  "The clipboard did not provide both the structured board selection and readable text.")
        _ = try await editor.perform("new")
        try await check(editor.perform("paste") as? Bool == true, "The workspace could not paste a board selection.")
        try await check(editor.perform("save") as? Bool == true, "The pasted objects did not save.")
        let newID = try json(at: store.libraryURL)["activeBoardId"] as? String
        let pasted = try boards(at: store.libraryURL).first { $0["id"] as? String == newID }
        let oldObjects = active?["objects"] as? [[String: Any]] ?? []
        let pastedObjects = pasted?["objects"] as? [[String: Any]] ?? []
        let oldIDs = Set(oldObjects.compactMap { $0["id"] as? String })
        let pastedIDs = Set(pastedObjects.compactMap { $0["id"] as? String })
        try check(pastedObjects.count == oldObjects.count && oldIDs.isDisjoint(with: pastedIDs)
                  && (pasted?["links"] as? [[String: Any]])?.count == (active?["links"] as? [[String: Any]])?.count,
                  "The Mac clipboard paste did not remap the objects and preserve their connections.")
        try await check(editor.perform("copyRich") as? Bool == true, "The board outline could not copy as rich text.")
        let rich = WebEditor.readClipboard(from: clipboard)
        try check(rich["html"]?.contains("<ul>") == true && rich["text"]?.contains("- ") == true,
                  "Rich outline copy did not provide nested HTML and readable text.")

        let original = try Data(contentsOf: store.libraryURL)
        let reopened = makeEditor(store: DocumentStore(directory: directory), window: window)
        try await waitUntilReady(reopened)
        try await check(reopened.perform("save") as? Bool == true, "The recreated WKWebView could not save the reopened workspace.")
        try check(Data(contentsOf: store.libraryURL) == original, "Reopening the workspace changed the saved board.")

        try await check(reopened.perform("example") as? Bool == true, "Could not open a new example for mapping checks.")
        _ = try await reopened.webView.callAsyncJavaScript(
            "document.querySelector('[data-object=takes]').click(); return true;", contentWorld: .page
        )
        try await check(reopened.perform("branchLeft") as? Bool == true, "The native left-child command failed.")
        try await check(reopened.perform("save") as? Bool == true, "The added left branch did not save.")
        let mapping = try json(at: store.libraryURL)
        let mappingID = mapping["activeBoardId"] as? String
        let mappedBoard = try boards(at: store.libraryURL).first { $0["id"] as? String == mappingID }
        let branches = mappedBoard?["branches"] as? [[String: Any]] ?? []
        try check(branches.contains { $0["parentId"] as? String == "takes" && $0["side"] as? String == "left" },
                  "The native branch command did not keep the selected side.")
        try await check(reopened.perform("selectAll") as? Bool == true, "Could not select the example before flow arrangement.")
        try await check(reopened.perform("flowDown") as? Bool == true, "The native vertical flow command failed.")
        try await check(reopened.perform("save") as? Bool == true, "The rearranged flow did not save.")
        let arranged = try boards(at: store.libraryURL).first { $0["id"] as? String == mappingID }
        let objects = arranged?["objects"] as? [[String: Any]] ?? []
        let micY = objects.first { $0["id"] as? String == "mic" }?["y"] as? Double
        let monitorY = objects.first { $0["id"] as? String == "monitor" }?["y"] as? Double
        guard let micY, let monitorY else { throw StoreError.message("The arranged flow lost an object.") }
        try check(micY < monitorY, "The native flow command did not arrange the selected chain top to bottom.")

        print("Mac WKWebView checks passed: native load/save, legacy import, cancelled import/export, mixed edits, undo/redo, vector export, scratch clipboard, fresh reopen, left child, and vertical flow.")
    }
}
