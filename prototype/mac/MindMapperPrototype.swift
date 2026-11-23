import AppKit

@main
@MainActor
final class MindMapperPrototype: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private static let appName = "Mind Mapper Prototype"
    private var window: NSWindow?
    private var editor: WebEditor?
    private var terminationPending = false

    static func main() {
        let app = NSApplication.shared
        let delegate = MindMapperPrototype()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
        withExtendedLifetime(delegate) {}
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMenus()
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 740),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = Self.appName
        window.minSize = NSSize(width: 560, height: 430)
        window.delegate = self
        window.center()
        self.window = window
        do {
            let override = ProcessInfo.processInfo.environment["MINDMAPPER_PROTOTYPE_DATA_DIR"]
            let directory: URL
            if let override {
                guard override.hasPrefix("/") else {
                    throw StoreError.message("Use an absolute path for the test workspace directory.")
                }
                directory = URL(fileURLWithPath: override, isDirectory: true)
            } else {
                let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                          appropriateFor: nil, create: true)
                directory = support.appendingPathComponent(Self.appName, isDirectory: true)
            }
            guard let root = Bundle.main.resourceURL?.appendingPathComponent("Web", isDirectory: true) else {
                throw StoreError.message("The bundled editor could not be found.")
            }
            let editor = WebEditor(resourceRoot: root, store: DocumentStore(directory: directory), ephemeral: override != nil)
            self.editor = editor
            window.contentView = editor.webView
            editor.didFail = { [weak self] message in self?.showError(message) }
            editor.load()
        } catch {
            showError(error.localizedDescription)
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        window?.makeKeyAndOrderFront(nil)
        return true
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        // Route the red close button through the same save check as Command-Q.
        NSApp.terminate(self)
        return false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let editor, editor.hasLoadedLibrary else { return .terminateNow }
        guard window?.attachedSheet == nil else { return .terminateCancel }
        guard !terminationPending else { return .terminateLater }
        terminationPending = true
        Task { @MainActor [weak self] in
            guard let self else {
                sender.reply(toApplicationShouldTerminate: false)
                return
            }
            do {
                if try await editor.perform("save") as? Bool == true {
                    sender.reply(toApplicationShouldTerminate: true)
                } else {
                    confirmQuit(sender, reason: "The workspace could not be saved.")
                }
            } catch {
                confirmQuit(sender, reason: error.localizedDescription)
            }
        }
        return .terminateLater
    }

    private func confirmQuit(_ sender: NSApplication, reason: String) {
        let alert = NSAlert()
        alert.messageText = "Quit without saving?"
        alert.informativeText = reason
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Keep Editing")
        alert.addButton(withTitle: "Quit Without Saving")
        let completion: (NSApplication.ModalResponse) -> Void = { [weak self] result in
            self?.terminationPending = false
            sender.reply(toApplicationShouldTerminate: result == .alertSecondButtonReturn)
        }
        if let window { alert.beginSheetModal(for: window, completionHandler: completion) }
        else { completion(alert.runModal()) }
    }

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = Self.appName
        alert.informativeText = message
        alert.alertStyle = .warning
        if let window { alert.beginSheetModal(for: window) }
        else { alert.runModal() }
    }

    @objc private func editorCommand(_ sender: NSMenuItem) {
        guard let editor, let action = sender.representedObject as? String else { return }
        Task { @MainActor [weak self] in
            do { _ = try await editor.perform(action) }
            catch { self?.showError(error.localizedDescription) }
        }
    }

    private func command(_ title: String, action: String, key: String = "", modifiers: NSEvent.ModifierFlags = [.command]) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: #selector(editorCommand(_:)), keyEquivalent: key)
        item.representedObject = action
        item.target = self
        item.keyEquivalentModifierMask = modifiers
        return item
    }

    private func installMenus() {
        let bar = NSMenu()
        func menu(_ title: String) -> NSMenu {
            let item = NSMenuItem()
            let submenu = NSMenu(title: title)
            item.submenu = submenu
            bar.addItem(item)
            return submenu
        }

        let app = menu(Self.appName)
        app.addItem(withTitle: "About " + Self.appName, action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Hide " + Self.appName, action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit " + Self.appName, action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let file = menu("File")
        file.addItem(command("New Board", action: "new", key: "n"))
        file.addItem(command("Open Map or Library…", action: "open", key: "o"))
        file.addItem(command("Save Workspace", action: "save", key: "s"))
        file.addItem(.separator())
        file.addItem(command("Export Editable Board…", action: "exportBoard"))
        file.addItem(command("Export SVG…", action: "exportSVG", key: "e", modifiers: [.command, .shift]))
        file.addItem(.separator())
        file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")

        let edit = menu("Edit")
        edit.addItem(command("Undo", action: "undo", key: "z"))
        edit.addItem(command("Redo", action: "redo", key: "z", modifiers: [.command, .shift]))
        edit.addItem(.separator())
        edit.addItem(command("Cut", action: "cut", key: "x"))
        edit.addItem(command("Copy", action: "copy", key: "c"))
        edit.addItem(command("Paste", action: "paste", key: "v"))
        edit.addItem(command("Select All", action: "selectAll", key: "a"))
        edit.addItem(.separator())
        edit.addItem(command("Duplicate Selection", action: "duplicate", key: "d"))
        edit.addItem(command("Find on Board…", action: "find", key: "f"))
        edit.addItem(command("Paste Outline…", action: "outline"))
        edit.addItem(command("Copy Markdown Outline", action: "copyMarkdown"))
        edit.addItem(command("Copy Rich Text Outline", action: "copyRich"))

        let arrange = menu("Arrange")
        arrange.addItem(command("Group in Frame", action: "group", key: "g"))
        arrange.addItem(command("Ungroup Frame", action: "ungroup", key: "g", modifiers: [.command, .shift]))
        arrange.addItem(command("Bring to Front", action: "front"))
        arrange.addItem(command("Send to Back", action: "back"))

        let view = menu("View")
        view.addItem(command("Fit Whole Board", action: "fit"))
        view.addItem(command("Fit Selection", action: "fitSelection"))
        view.addItem(command("Centre Canvas", action: "centre"))
        view.addItem(.separator())
        view.addItem(command("Toggle Grid", action: "grid"))
        view.addItem(command("Toggle Grid Snapping", action: "snapGrid"))
        view.addItem(command("Toggle Object Snapping", action: "snapObjects"))

        let windows = menu("Window")
        windows.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windows.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        NSApp.windowsMenu = windows
        NSApp.mainMenu = bar
    }
}
