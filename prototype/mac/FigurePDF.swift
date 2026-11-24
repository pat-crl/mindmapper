import CoreGraphics
import WebKit

@MainActor
final class FigurePDF: NSObject, WKNavigationDelegate {
    static let maximumSide = 14_400.0
    private let view: WKWebView
    private var pendingLoad: CheckedContinuation<Void, Error>?

    private override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        view = WKWebView(frame: CGRect(x: 0, y: 0, width: 10, height: 10), configuration: configuration)
        super.init()
        view.navigationDelegate = self
    }

    static func render(svg: String, width: Double, height: Double) async throws -> Data {
        guard width.isFinite, height.isFinite, width > 0, height > 0,
              width <= maximumSide, height <= maximumSide else {
            throw StoreError.message("PDF supports a page up to 14,400 × 14,400 points. Export a smaller area or use SVG.")
        }
        let markup = svg.trimmingCharacters(in: .whitespacesAndNewlines)
        guard markup.hasPrefix("<svg "), markup.hasSuffix("</svg>") else {
            throw StoreError.message("The PDF figure is missing its SVG drawing.")
        }
        let renderer = FigurePDF()
        return try await renderer.capture(markup, width: ceil(width), height: ceil(height))
    }

    private func capture(_ svg: String, width: Double, height: Double) async throws -> Data {
        // Only the figure enters this isolated view. Its paths and text are painted
        // by WebKit into a PDF context with the same CSS units as the figure preview.
        let html = """
        <!doctype html><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'">
        <style>html, body { margin: 0; padding: 0; background: transparent; } svg { display: block; }</style>
        \(svg)
        """
        let timeout = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .seconds(12)) }
            catch { return }
            self?.finishLoad(.failure(StoreError.message("The PDF figure took too long to load.")))
        }
        defer { timeout.cancel() }
        try await withCheckedThrowingContinuation { continuation in
            pendingLoad = continuation
            view.loadHTMLString(html, baseURL: nil)
        }
        timeout.cancel()

        let bounds = CGRect(x: 0, y: 0, width: width, height: height)
        let configuration = WKPDFConfiguration()
        configuration.rect = bounds
        configuration.allowTransparentBackground = true
        let bytes = try await view.pdf(configuration: configuration)
        guard let provider = CGDataProvider(data: bytes as CFData),
              let document = CGPDFDocument(provider), document.numberOfPages == 1,
              document.page(at: 1)?.getBoxRect(.mediaBox).size == bounds.size else {
            throw StoreError.message("The figure could not fit on a single PDF page. Export a smaller area or use SVG.")
        }
        return bytes
    }

    private func finishLoad(_ result: Result<Void, Error>) {
        let continuation = pendingLoad
        pendingLoad = nil
        continuation?.resume(with: result)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let isRenderPage = navigationAction.targetFrame?.isMainFrame == true
            && navigationAction.request.url?.absoluteString == "about:blank"
        decisionHandler(isRenderPage ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        finishLoad(.success(()))
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finishLoad(.failure(error))
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finishLoad(.failure(error))
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        finishLoad(.failure(StoreError.message("The PDF renderer stopped before exporting the figure.")))
    }
}
