import AppKit
import ImageIO
import UniformTypeIdentifiers
import WebKit

@MainActor
final class WebEditor: NSObject, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
    private typealias Reply = (Any?, String?) -> Void
    typealias ChooseFile = @MainActor (NSSavePanel, NSWindow, @escaping (URL?) -> Void) -> Void

    static let mapType = UTType(exportedAs: "au.pcarroll.mindmapper.prototype.board", conformingTo: .json)
    private static let maximumExportBytes = 30 * 1024 * 1024
    private static let selectionType = NSPasteboard.PasteboardType("au.pcarroll.mindmapper.selection")
    private static let textActions: [String: Selector] = [
        "cut": #selector(NSText.cut(_:)), "copy": #selector(NSText.copy(_:)),
        "paste": #selector(NSText.paste(_:)), "selectAll": #selector(NSText.selectAll(_:)),
    ]

    let webView: WKWebView
    private let store: DocumentStore
    private let editorURL: URL
    private let resourceRoot: URL
    private let chooseFile: ChooseFile
    private let pasteboard: NSPasteboard
    private var pickerOpen = false
    private var shares: [UUID: FigureShare] = [:]
    private var lastExport: (id: String, url: URL)?
    private(set) var hasLoadedLibrary = false
    private(set) var isImportingFile = false
    var didFail: ((String) -> Void)?
    var didLoadPage: (() -> Void)?
    var didImportFile: ((URL) -> Void)?
    var didFinishImport: (() -> Void)?

    init(resourceRoot: URL, store: DocumentStore, ephemeral: Bool = false,
         pasteboard: NSPasteboard = .general,
         chooseFile: @escaping ChooseFile = { panel, window, selection in
             panel.beginSheetModal(for: window) { result in selection(result == .OK ? panel.url : nil) }
         }) {
        self.store = store
        self.chooseFile = chooseFile
        self.pasteboard = pasteboard
        self.resourceRoot = resourceRoot.resolvingSymlinksInPath().standardizedFileURL
        editorURL = self.resourceRoot.appendingPathComponent("prototype/index.html")
        let config = WKWebViewConfiguration()
        if ephemeral { config.websiteDataStore = .nonPersistent() }
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        config.userContentController.addScriptMessageHandler(WeakBridge(self), contentWorld: .page, name: "mindmapper")
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
    }

    func load() {
        guard FileManager.default.fileExists(atPath: editorURL.path) else {
            didFail?("The bundled editor could not be found.")
            return
        }
        webView.loadFileURL(editorURL, allowingReadAccessTo: resourceRoot)
    }

    func perform(_ action: String) async throws -> Any? {
        let result = try await webView.callAsyncJavaScript(
            """
            if (!window.MindMapperPrototype) throw new Error('The editor is still opening.');
            const field = document.activeElement;
            const textField = field?.matches('textarea, input:not([type]), input[type="text"], input[type="search"], input[type="url"], input[type="email"], input[type="password"], input[type="tel"], input[type="number"]');
            if (field?.getClientRects().length && (textField || field.isContentEditable)) {
                if (action === 'undo' || action === 'redo') return document.execCommand(action);
                if (['cut', 'copy', 'paste', 'selectAll'].includes(action)) return { standardTextAction: action };
            }
            return await window.MindMapperPrototype.perform(action);
            """,
            arguments: ["action": action],
            in: nil,
            contentWorld: .page
        )
        if let textAction = (result as? [String: String])?["standardTextAction"],
           let selector = Self.textActions[textAction] {
            return NSApp.sendAction(selector, to: nil, from: webView)
        }
        return result
    }

    private func isEditorURL(_ url: URL?) -> Bool {
        guard let url, url.isFileURL else { return false }
        return url.resolvingSymlinksInPath().standardizedFileURL == editorURL
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let allowed = navigationAction.targetFrame?.isMainFrame == true && isEditorURL(navigationAction.request.url)
        decisionHandler(allowed ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        didFail?(error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        didLoadPage?()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        didFail?(error.localizedDescription)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        didFail?("The editor process stopped. Reopen the app to load the last acknowledged save.")
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard
            message.frameInfo.isMainFrame,
            isEditorURL(message.frameInfo.request.url),
            let body = message.body as? [String: Any],
            let action = body["action"] as? String
        else {
            replyHandler(nil, "The request did not come from the bundled editor.")
            return
        }
        do {
            switch action {
            case "load":
                let text = try store.load()
                hasLoadedLibrary = true
                replyHandler(text as Any? ?? NSNull(), nil)
            case "save":
                guard let text = body["text"] as? String else {
                    throw StoreError.message("Missing workspace text.")
                }
                try store.save(text)
                replyHandler(true, nil)
            case "import":
                try openFile(replyHandler)
            case "export":
                try outputFile(body, share: false, replyHandler)
            case "revealExport":
                guard let lastExport, body["id"] as? String == lastExport.id,
                      FileManager.default.fileExists(atPath: lastExport.url.path) else {
                    throw StoreError.message("This export is no longer at its saved location.")
                }
                NSWorkspace.shared.activateFileViewerSelecting([lastExport.url])
                replyHandler(true, nil)
            case "share":
                try outputFile(body, share: true, replyHandler)
            case "readClipboard":
                replyHandler(Self.readClipboard(from: pasteboard), nil)
            case "writeClipboard":
                try Self.writeClipboard(body, to: pasteboard)
                replyHandler(true, nil)
            case "openSource":
                guard let value = body["url"] as? String,
                      let url = Self.sourceURL(value) else {
                    throw StoreError.message("Enter a complete HTTP or HTTPS source link.")
                }
                guard NSWorkspace.shared.open(url) else {
                    throw StoreError.message("Couldn’t open this source link.")
                }
                replyHandler(true, nil)
            default:
                throw StoreError.message("Unknown Mac file action.")
            }
        } catch {
            replyHandler(nil, error.localizedDescription)
        }
    }

    private static func sourceURL(_ text: String) -> URL? {
        guard text.utf8.count <= 2000,
              let components = URLComponents(string: text),
              let scheme = components.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = components.host, !host.isEmpty else { return nil }
        return components.url
    }

    private static func validSelection(_ text: String) -> Bool {
        guard text.utf8.count <= DocumentStore.maximumBytes,
              let value = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { return false }
        // The editor validates the individual records and remaps their IDs when pasting.
        return value["format"] as? String == "mindmapper.selection"
            && value["version"] as? Int == 1
            && value["objects"] is [Any]
            && value["branches"] is [Any]
            && value["links"] is [Any]
    }

    static func readClipboard(from pasteboard: NSPasteboard = .general) -> [String: String] {
        var contents: [String: String] = [:]
        for (key, type) in [("text", NSPasteboard.PasteboardType.string), ("html", .html)] {
            if let value = pasteboard.string(forType: type), value.utf8.count <= DocumentStore.maximumBytes {
                contents[key] = value
            }
        }
        if let selection = pasteboard.string(forType: selectionType), validSelection(selection) {
            contents["selection"] = selection
        }
        return contents
    }

    static func writeClipboard(_ contents: [String: Any], to pasteboard: NSPasteboard = .general) throws {
        guard let text = contents["text"] as? String, text.utf8.count <= DocumentStore.maximumBytes else {
            throw StoreError.message("Clipboard text is missing or exceeds 20 MB.")
        }
        let item = NSPasteboardItem()
        guard item.setString(text, forType: .string) else {
            throw StoreError.message("Couldn’t prepare the clipboard text.")
        }
        if let rawHTML = contents["html"] {
            guard let html = rawHTML as? String, html.utf8.count <= DocumentStore.maximumBytes,
                  item.setString(html, forType: .html) else {
                throw StoreError.message("Clipboard HTML is invalid or exceeds 20 MB.")
            }
        }
        if let rawSelection = contents["selection"] {
            guard let selection = rawSelection as? String, validSelection(selection),
                  item.setString(selection, forType: selectionType) else {
                throw StoreError.message("The board selection cannot be copied.")
            }
        }
        pasteboard.clearContents()
        guard pasteboard.writeObjects([item]) else {
            throw StoreError.message("Couldn’t copy to the Mac clipboard.")
        }
    }

    private func windowForPicker() throws -> NSWindow {
        guard let window = webView.window, !pickerOpen, window.attachedSheet == nil else {
            throw StoreError.message("Close the current file picker and try again.")
        }
        return window
    }

    private func openFile(_ reply: @escaping Reply) throws {
        guard !isImportingFile else { throw StoreError.message("A file is already being imported.") }
        let window = try windowForPicker()
        let panel = NSOpenPanel()
        panel.title = "Open a Mind Mapper File"
        panel.prompt = "Import Copy"
        panel.allowedContentTypes = [.json, Self.mapType]
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        pickerOpen = true
        isImportingFile = true
        chooseFile(panel, window) { [self] url in
            pickerOpen = false
            guard let url else {
                finishImport()
                reply(false, nil)
                return
            }
            Task { @MainActor [self] in
                do { reply(try await self.importSelectedFile(at: url), nil) }
                catch { reply(nil, error.localizedDescription) }
            }
        }
    }

    func importFile(at url: URL) async throws -> Bool {
        guard !isImportingFile else { throw StoreError.message("A file is already being imported.") }
        isImportingFile = true
        return try await importSelectedFile(at: url)
    }

    private func finishImport() {
        isImportingFile = false
        didFinishImport?()
    }

    private func importSelectedFile(at url: URL) async throws -> Bool {
        let access = url.startAccessingSecurityScopedResource()
        defer {
            if access { url.stopAccessingSecurityScopedResource() }
            finishImport()
        }
        let text = try DocumentStore.readText(at: url)
        let result = try await webView.callAsyncJavaScript(
            """
            const editor = window.MindMapperPrototype;
            if (!(await editor?.ready)) return { error: 'Open a workspace before importing a file.' };
            try { return { imported: await editor.importText(text) }; }
            catch (error) { return { error: error.message || String(error) }; }
            """,
            arguments: ["text": text], in: nil, contentWorld: .page
        ) as? [String: Any]
        if let error = result?["error"] as? String { throw StoreError.message(error) }
        let imported = result?["imported"] as? Bool == true
        if imported { didImportFile?(url) }
        return imported
    }

    private func outputFile(_ body: [String: Any], share: Bool, _ reply: @escaping Reply) throws {
        guard let name = body["name"] as? String, !name.isEmpty, name.count <= 200,
              name == (name as NSString).lastPathComponent, !name.contains(":"), !name.contains("\0") else {
            throw StoreError.message("Invalid export filename.")
        }
        let filenameExtension = (name as NSString).pathExtension.lowercased()
        let type: UTType
        switch filenameExtension {
        case "svg": type = .svg
        case "mindmap": type = Self.mapType
        case "json": type = .json
        case "pdf": type = .pdf
        case "png": type = .png
        case "jpg", "jpeg": type = .jpeg
        default: throw StoreError.message("Choose a supported figure or editable file format.")
        }
        let window = try windowForPicker()
        pickerOpen = true
        Task { @MainActor [self] in
            do {
                let bytes = try await Self.outputData(body, as: type)
                if share {
                    let id = UUID()
                    let item = try FigureShare(name: name, bytes: bytes, id: id) { [weak self] in
                        self?.pickerOpen = false
                    } finished: { [weak self] in
                        self?.shares.removeValue(forKey: id)
                    }
                    shares[id] = item
                    item.show(in: webView)
                    reply(true, nil)
                } else {
                    saveFile(bytes, name: name, type: type, window: window, reply)
                }
            } catch {
                pickerOpen = false
                reply(nil, error.localizedDescription)
            }
        }
    }

    private static func outputData(_ body: [String: Any], as type: UTType) async throws -> Data {
        let bytes: Data
        switch type {
        case .pdf:
            guard let svg = body["svg"] as? String,
                  let width = body["width"] as? Double, let height = body["height"] as? Double else {
                throw StoreError.message("Missing PDF drawing or page dimensions.")
            }
            guard svg.utf8.count <= maximumExportBytes else {
                throw StoreError.message("The PDF drawing exceeds the 30 MB limit.")
            }
            bytes = try await FigurePDF.render(svg: svg, width: width, height: height)
        case .png, .jpeg:
            guard let encoded = body["base64"] as? String else {
                throw StoreError.message("Missing raster export data.")
            }
            guard encoded.utf8.count <= ((maximumExportBytes + 2) / 3) * 4 else {
                throw StoreError.message("The export exceeds the 30 MB limit. Choose a smaller area or scale.")
            }
            guard let data = Data(base64Encoded: encoded),
                  let source = CGImageSourceCreateWithData(data as CFData, nil),
                  CGImageSourceGetType(source) as String? == type.identifier,
                  CGImageSourceGetStatus(source) == .statusComplete else {
                throw StoreError.message("The image data does not match the chosen export format.")
            }
            bytes = data
        default:
            guard let text = body["text"] as? String else {
                throw StoreError.message("Missing text export data.")
            }
            bytes = Data(text.utf8)
        }
        guard !bytes.isEmpty, bytes.count <= maximumExportBytes else {
            throw StoreError.message("The export is empty or exceeds the 30 MB limit.")
        }
        return bytes
    }

    private func saveFile(_ bytes: Data, name: String, type: UTType, window: NSWindow, _ reply: @escaping Reply) {
        let panel = NSSavePanel()
        panel.title = "Export from Mind Mapper"
        panel.nameFieldStringValue = name
        panel.directoryURL = lastExport?.url.deletingLastPathComponent()
        panel.allowedContentTypes = [type]
        panel.canCreateDirectories = true
        chooseFile(panel, window) { [self] url in
            pickerOpen = false
            guard let url else {
                reply(NSNull(), nil)
                return
            }
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            do {
                let extensionMatches = type == Self.mapType
                    ? url.pathExtension.lowercased() == "mindmap"
                    : UTType(filenameExtension: url.pathExtension.lowercased()) == type
                guard extensionMatches else {
                    throw StoreError.message("The filename extension must match the chosen export format.")
                }
                try bytes.write(to: url, options: .atomic)
                let id = UUID().uuidString
                lastExport = (id, url)
                reply(["id": id, "name": url.lastPathComponent, "folder": url.deletingLastPathComponent().lastPathComponent], nil)
            } catch {
                reply(nil, error.localizedDescription)
            }
        }
    }
}

// WKUserContentController retains its handler. Break the editor → web view →
// handler cycle so closing a window or running repeated smoke checks releases it.
@MainActor
private final class WeakBridge: NSObject, WKScriptMessageHandlerWithReply {
    private weak var editor: WebEditor?

    init(_ editor: WebEditor) {
        self.editor = editor
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let editor else {
            replyHandler(nil, "The editor window is closed.")
            return
        }
        editor.userContentController(userContentController, didReceive: message, replyHandler: replyHandler)
    }
}
