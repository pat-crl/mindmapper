import AppKit
import WebKit

@main
@MainActor
final class WebBridgeChecks: NSObject, NSApplicationDelegate {
    private let resourceRoot: URL
    private let temporary: URL
    private let legacyFixture: URL
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
        let editor = WebEditor(resourceRoot: resourceRoot, store: store, ephemeral: true) { [self] panel, _, selection in
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

        let original = try Data(contentsOf: store.libraryURL)
        let reopened = makeEditor(store: DocumentStore(directory: directory), window: window)
        try await waitUntilReady(reopened)
        try await check(reopened.perform("save") as? Bool == true, "The recreated WKWebView could not save the reopened workspace.")
        try check(Data(contentsOf: store.libraryURL) == original, "Reopening the workspace changed the saved board.")

        print("Mac WKWebView checks passed: native load/save, legacy import, cancelled import/export, mixed objects, multiline DOM edit, undo/redo, editable/SVG export and a fresh editor reopen.")
    }
}
