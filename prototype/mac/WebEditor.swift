import AppKit
import UniformTypeIdentifiers
import WebKit

@MainActor
final class WebEditor: NSObject, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
    private typealias Reply = (Any?, String?) -> Void
    typealias ChooseFile = @MainActor (NSSavePanel, NSWindow, @escaping (URL?) -> Void) -> Void

    static let mapType = UTType(exportedAs: "au.pcarroll.mindmapper.prototype.board", conformingTo: .json)
    private static let maximumExportBytes = 30 * 1024 * 1024

    let webView: WKWebView
    private let store: DocumentStore
    private let editorURL: URL
    private let resourceRoot: URL
    private let chooseFile: ChooseFile
    private var pickerOpen = false
    private(set) var hasLoadedLibrary = false
    var didFail: ((String) -> Void)?

    init(resourceRoot: URL, store: DocumentStore, ephemeral: Bool = false,
         chooseFile: @escaping ChooseFile = { panel, window, selection in
             panel.beginSheetModal(for: window) { result in selection(result == .OK ? panel.url : nil) }
         }) {
        self.store = store
        self.chooseFile = chooseFile
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
        try await webView.callAsyncJavaScript(
            """
            if (!window.MindMapperPrototype) throw new Error('The editor is still opening.');
            if ((action === 'undo' || action === 'redo') &&
                document.activeElement?.matches('textarea, input:not([type]), input[type="text"], [contenteditable="true"]')) {
                return document.execCommand(action);
            }
            return await window.MindMapperPrototype.perform(action);
            """,
            arguments: ["action": action],
            in: nil,
            contentWorld: .page
        )
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
                try exportFile(body, replyHandler)
            default:
                throw StoreError.message("Unknown Mac file action.")
            }
        } catch {
            replyHandler(nil, error.localizedDescription)
        }
    }

    private func windowForPicker() throws -> NSWindow {
        guard let window = webView.window, !pickerOpen, window.attachedSheet == nil else {
            throw StoreError.message("Close the current file picker and try again.")
        }
        return window
    }

    private func openFile(_ reply: @escaping Reply) throws {
        let window = try windowForPicker()
        let panel = NSOpenPanel()
        panel.title = "Open a Mind Mapper File"
        panel.prompt = "Import Copy"
        panel.allowedContentTypes = [.json, Self.mapType]
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        pickerOpen = true
        chooseFile(panel, window) { [self] url in
            pickerOpen = false
            guard let url else {
                reply(NSNull(), nil)
                return
            }
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            do { reply(try DocumentStore.readText(at: url), nil) }
            catch { reply(nil, error.localizedDescription) }
        }
    }

    private func exportFile(_ body: [String: Any], _ reply: @escaping Reply) throws {
        guard let name = body["name"] as? String, !name.isEmpty, name.count <= 200,
              name == (name as NSString).lastPathComponent, !name.contains(":"), !name.contains("\0"),
              let text = body["text"] as? String else {
            throw StoreError.message("Invalid export filename or content.")
        }
        let filenameExtension = (name as NSString).pathExtension.lowercased()
        let type: UTType
        switch filenameExtension {
        case "svg": type = .svg
        case "mindmap": type = Self.mapType
        case "json": type = .json
        default: throw StoreError.message("Choose SVG, Mind Mapper or JSON export.")
        }
        let bytes = Data(text.utf8)
        guard bytes.count <= Self.maximumExportBytes else {
            throw StoreError.message("The export exceeds the 30 MB limit.")
        }
        let window = try windowForPicker()
        let panel = NSSavePanel()
        panel.title = "Export Board"
        panel.nameFieldStringValue = name
        panel.allowedContentTypes = [type]
        panel.canCreateDirectories = true
        pickerOpen = true
        chooseFile(panel, window) { [self] url in
            pickerOpen = false
            guard let url else {
                reply(NSNull(), nil)
                return
            }
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            do {
                try bytes.write(to: url, options: .atomic)
                reply(true, nil)
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
