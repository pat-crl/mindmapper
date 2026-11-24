import AppKit
import PDFKit
import WebKit

@main
@MainActor
final class WebBridgeChecks: NSObject, NSApplicationDelegate {
    private let resourceRoot: URL
    private let temporary: URL
    private let legacyFixture: URL
    private let clipboard = NSPasteboard(name: .init("MindMapperChecks-" + UUID().uuidString))
    private var cancelSelection = false
    private var failDestination = false
    private var outputStem = "Export"

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
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
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
                let parent = failDestination ? temporary.appendingPathComponent("Missing folder") : temporary
                failDestination = false
                selection(parent.appendingPathComponent(outputStem + "." + ext))
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

    private func writeFigure(_ format: String, in editor: WebEditor) async throws -> String {
        let ready = try await editor.webView.callAsyncJavaScript(
            """
            const dialog = document.querySelector('#export-dialog');
            if (!dialog.open) return false;
            for (const [id, value] of [['format', format], ['padding', '48'], ['background', 'transparent']]) {
                const field = document.querySelector('#export-' + id);
                field.value = value;
                field.dispatchEvent(new Event('change', { bubbles: true }));
            }
            const button = document.querySelector('#export-save');
            if (button.disabled) return false;
            button.click();
            return true;
            """,
            arguments: ["format": format],
            contentWorld: .page
        )
        try check(ready as? Bool == true, "The native figure preview could not save \(format).")
        for _ in 0..<160 {
            let status = try await editor.webView.callAsyncJavaScript(
                "return document.querySelector('#export-status').textContent;",
                contentWorld: .page
            ) as? String ?? ""
            if !status.isEmpty && status != "Preparing figure…" { return status }
            try await Task.sleep(for: .milliseconds(50))
        }
        throw StoreError.message("The native \(format) figure did not finish.")
    }

    private func verifyFigureExports(_ editor: WebEditor, expectedText: String) async throws {
        outputStem = "Figure"
        defer { outputStem = "Export" }
        try await check(editor.perform("exportFigure") as? Bool == true, "The Mac figure command did not open the preview.")
        for format in ["svg", "pdf", "png", "jpeg"] {
            let status = try await writeFigure(format, in: editor)
            let ext = format == "jpeg" ? "jpg" : format
            try check(status == "Saved to \(temporary.lastPathComponent) · Figure.\(ext)",
                      "Saving a \(format) figure returned: \(status)")
            let canReveal = try await editor.webView.callAsyncJavaScript(
                "return !document.querySelector('#export-reveal').hidden;", contentWorld: .page)
            try check(canReveal as? Bool == true, "A saved figure could not be located from the preview.")
        }
        func output(_ ext: String) -> URL { temporary.appendingPathComponent("Figure." + ext) }
        let svg = try XMLDocument(contentsOf: output("svg"), options: [.nodeLoadExternalEntitiesNever])
        guard let root = svg.rootElement(),
              let width = root.attribute(forName: "width")?.stringValue.flatMap(Double.init),
              let height = root.attribute(forName: "height")?.stringValue.flatMap(Double.init) else {
            throw StoreError.message("The saved figure SVG has no explicit dimensions.")
        }
        guard let pdf = PDFDocument(url: output("pdf")), let page = pdf.page(at: 0), let pageRef = page.pageRef,
              let thumbnail = CGContext(data: nil, width: 16, height: 16, bitsPerComponent: 8, bytesPerRow: 0,
                                        space: CGColorSpaceCreateDeviceRGB(),
                                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            throw StoreError.message("The saved vector PDF could not be opened.")
        }
        try check(pdf.pageCount == 1 && page.bounds(for: .mediaBox).size == CGSize(width: width, height: height),
                  "The PDF page did not keep the SVG figure dimensions.")
        try check(page.string?.contains(expectedText) == true, "The PDF did not preserve live figure text.")
        thumbnail.scaleBy(x: 16 / width, y: 16 / height)
        thumbnail.drawPDFPage(pageRef)
        try check(thumbnail.data?.assumingMemoryBound(to: UInt8.self)[3] == 0, "Transparent PDF padding became opaque.")
        guard let png = NSBitmapImageRep(data: try Data(contentsOf: output("png"))),
              let jpeg = NSBitmapImageRep(data: try Data(contentsOf: output("jpg"))) else {
            throw StoreError.message("The native PNG or JPEG could not be opened.")
        }
        try check(Double(png.pixelsWide) == width && Double(png.pixelsHigh) == height
                  && png.colorAt(x: 0, y: 0)?.alphaComponent == 0, "The PNG lost its expected dimensions or transparency.")
        try check(Double(jpeg.pixelsWide) == width && Double(jpeg.pixelsHigh) == height
                  && !jpeg.hasAlpha, "The JPEG lost its expected dimensions or solid background.")

        let priorSVG = try Data(contentsOf: output("svg"))
        cancelSelection = true
        try await check(writeFigure("svg", in: editor) == "Save cancelled.", "The preview did not report cancellation.")
        failDestination = true
        let failed = try await writeFigure("png", in: editor)
        try check(!failed.hasPrefix("Saved to ") && failed != "Save cancelled."
                  && !FileManager.default.fileExists(atPath: temporary.appendingPathComponent("Missing folder").path),
                  "A failed native write claimed success or left an incomplete destination.")
        try check(Data(contentsOf: output("svg")) == priorSVG, "Cancelled save changed the prior SVG.")
        _ = try await editor.webView.callAsyncJavaScript(
            "document.querySelector('#export-close').click(); return true;",
            contentWorld: .page
        )
        _ = try await editor.perform("exportLibrary")
        let library = try json(at: temporary.appendingPathComponent("Figure.json"))
        try check(library["format"] as? String == "mindmapper.workspace" && library["boards"] is [[String: Any]],
                  "Editable library export did not retain the workspace structure.")
    }

    private func verifyInvalidExports(_ editor: WebEditor) async throws {
        let errors = try await editor.webView.callAsyncJavaScript(
            """
            const bridge = window.webkit.messageHandlers.mindmapper;
            const failures = [];
            for (const payload of [
                { name: 'Invalid.pdf', width: 14401, height: 1, svg: '<svg width="1" height="1"></svg>' },
                { name: 'Invalid.png', base64: 'AAECAw==' },
            ]) {
                try {
                    await bridge.postMessage({ action: 'export', ...payload });
                    failures.push(null);
                } catch (error) { failures.push(error.message); }
            }
            return failures;
            """,
            contentWorld: .page
        ) as? [String]
        try check(errors?.first?.contains("14,400") == true && errors?.last?.contains("does not match") == true,
                  "An oversized PDF or invalid blob reached the save panel.")
    }

    private func verifyQueuedSaves(_ editor: WebEditor, store: DocumentStore) async throws {
        let result = try await editor.webView.callAsyncJavaScript(
            """
            const editor = window.MindMapperPrototype;
            const bridge = window.webkit.messageHandlers.mindmapper;
            const original = bridge.postMessage;
            const title = document.querySelector('#board-title');
            const savedTitles = [];
            let nativeSaved, resume;
            const firstNativeSave = new Promise(resolve => { nativeSaved = resolve; });
            const firstAcknowledgement = new Promise(resolve => { resume = resolve; });
            bridge.postMessage = async function (message) {
                if (message.action !== 'save') return original.call(bridge, message);
                const workspace = JSON.parse(message.text);
                savedTitles.push(workspace.boards.find(board => board.id === workspace.activeBoardId).title);
                const first = savedTitles.length === 1;
                const result = await original.call(bridge, message);
                if (first) {
                    nativeSaved(true);
                    await firstAcknowledgement;
                }
                return result;
            };
            try {
                title.focus();
                title.value = 'First uncommitted title';
                const first = editor.perform('save');
                const started = await Promise.race([firstNativeSave, new Promise(resolve => setTimeout(() => resolve(false), 2000))]);
                if (!started) throw new Error('The first save had no native acknowledgement to delay.');
                title.value = 'Title edited during save';
                let settled = false;
                const second = editor.perform('save').then(ok => { settled = true; return ok; });
                await new Promise(resolve => setTimeout(resolve, 30));
                const waiting = !settled && savedTitles.length === 1;
                resume();
                return { waiting, saved: await Promise.all([first, second]), savedTitles };
            } finally {
                resume();
                bridge.postMessage = original;
            }
            """,
            contentWorld: .page
        ) as? [String: Any]
        try check(result?["waiting"] as? Bool == true && result?["saved"] as? [Bool] == [true, true],
                  "A quit-style save did not wait on the pending native acknowledgement.")
        try check(result?["savedTitles"] as? [String] == ["First uncommitted title", "Title edited during save"],
                  "The save queue did not commit focused title edits in sequence.")
        let afterQueue = try json(at: store.libraryURL)
        let activeID = afterQueue["activeBoardId"] as? String
        try check(boards(at: store.libraryURL).first { $0["id"] as? String == activeID }?["title"] as? String == "Title edited during save",
                  "The latest draft was not present in the acknowledged on-disk workspace.")
    }

    private func verifyBackgroundSave(_ editor: WebEditor, store: DocumentStore) async throws {
        let objectID = try await editor.webView.callAsyncJavaScript(
            """
            const object = document.querySelector('.object[data-type="shape"][data-locked="false"]');
            if (!object) throw new Error('No unlocked shape is available to edit.');
            object.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            const text = document.querySelector('#object-editor');
            if (text.hidden) throw new Error('The background-save test did not open the text editor.');
            text.value = 'Draft saved when hidden';
            text.dispatchEvent(new Event('input', { bubbles: true }));
            Object.defineProperty(document, 'hidden', { value: true, configurable: true });
            try { document.dispatchEvent(new Event('visibilitychange')); }
            finally { delete document.hidden; }
            return object.dataset.object;
            """,
            contentWorld: .page
        ) as? String
        try check(objectID != nil, "The background-save test did not identify the edited object.")
        for _ in 0..<50 {
            let activeID = try json(at: store.libraryURL)["activeBoardId"] as? String
            let active = try boards(at: store.libraryURL).first { $0["id"] as? String == activeID }
            let objects = active?["objects"] as? [[String: Any]] ?? []
            if objects.contains(where: { ($0["id"] as? String) == objectID && ($0["text"] as? String) == "Draft saved when hidden" }) { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw StoreError.message("Backgrounding did not commit and save the pending draft through the native bridge.")
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
        try await verifyFigureExports(editor, expectedText: "Prototype note")
        try await verifyInvalidExports(editor)

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

        try await verifyQueuedSaves(reopened, store: store)
        try await verifyBackgroundSave(reopened, store: store)

        print("Mac WKWebView checks passed: native load/save, legacy import, mixed edits, undo/redo, SVG/PDF/PNG/JPEG preview export, editable exports, cancelled/invalid/interrupted saves, scratch clipboard, fresh reopen, left child, vertical flow, quit-style queued acknowledgement and background draft save.")
    }
}
