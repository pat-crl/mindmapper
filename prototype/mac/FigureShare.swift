import AppKit

@MainActor
final class FigureShare: NSObject, @preconcurrency NSSharingServicePickerDelegate, NSSharingServiceDelegate {
    private let directory: URL
    private let picker: NSSharingServicePicker
    private let picked: () -> Void
    private let finished: () -> Void

    init(name: String, bytes: Data, id: UUID, picked: @escaping () -> Void, finished: @escaping () -> Void) throws {
        self.picked = picked
        self.finished = finished
        let files = FileManager.default
        let directory = files.temporaryDirectory.appendingPathComponent("mindmapper-share-" + id.uuidString, isDirectory: true)
        self.directory = directory
        try files.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        do {
            let url = directory.appendingPathComponent(name)
            try bytes.write(to: url, options: .atomic)
            picker = NSSharingServicePicker(items: [url])
        } catch {
            try? files.removeItem(at: directory)
            throw error
        }
        super.init()
        picker.delegate = self
    }

    deinit {
        try? FileManager.default.removeItem(at: directory)
    }

    func show(in view: NSView) {
        let anchor = NSRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        picker.show(relativeTo: anchor, of: view, preferredEdge: .minY)
    }

    func sharingServicePicker(_ sharingServicePicker: NSSharingServicePicker,
                              delegateFor sharingService: NSSharingService) -> (any NSSharingServiceDelegate)? {
        self
    }

    func sharingServicePicker(_ sharingServicePicker: NSSharingServicePicker,
                              didChoose service: NSSharingService?) {
        picked()
        if service == nil { finished() }
    }

    func sharingService(_ sharingService: NSSharingService, didShareItems items: [Any]) {
        finished()
    }

    func sharingService(_ sharingService: NSSharingService, didFailToShareItems items: [Any], error: Error) {
        finished()
    }
}
