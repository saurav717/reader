// Reader.app: the reader on a Mac, as an app from a signed, notarized .dmg.
//
// The first time it opens (and after an update) it installs the Reader
// Companion from the wheel inside the app, with the uv inside the app, and runs
// `reader-companion setup --no-app`: the Jupyter server at every login, the
// VS Code extension, and the site paired. A window shows how that goes. Every
// time after, it runs `reader-companion open`: the Companion started if it
// isn't running, and the site in a window of its own. Then it quits.
//
// Built by desktop/macos/build.sh. The rest of the work is the Companion's
// (companion/reader_companion/desktop.py); this is only the way in.

import AppKit

final class Reader: NSObject, NSApplicationDelegate {
    private let home = FileManager.default.homeDirectoryForCurrentUser
    private let resources = Bundle.main.resourceURL!
    private var companion: URL { home.appendingPathComponent(".local/bin/reader-companion") }
    private var wanted: String { Bundle.main.object(forInfoDictionaryKey: "ReaderCompanionVersion") as? String ?? "" }

    private var window: NSWindow?
    private var status = NSTextField(labelWithString: "")
    private var spinner = NSProgressIndicator()
    private var log = NSTextView()
    private var running: Process?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Set up when there is no Companion yet, or this app carries a newer one. One the
        // site updated (Settings → This computer → Update) can be newer than this app's: keep it.
        if let installed = installedVersion(), !isOlder(installed, than: wanted) {
            open()
        } else {
            install()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        // Setting up is left to finish if the window is closed; opening isn't worth keeping.
        if let process = running, process.isRunning, window == nil { process.terminate() }
    }

    // MARK: - The two jobs

    /// The Companion's version when it is installed, from `reader-companion --version`.
    private func installedVersion() -> String? {
        guard FileManager.default.isExecutableFile(atPath: companion.path) else { return nil }
        let process = Process()
        process.executableURL = companion
        process.arguments = ["--version"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do { try process.run() } catch { return nil }
        process.waitUntilExit()
        let text = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return text.split(separator: " ").last.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    }

    private func isOlder(_ version: String, than other: String) -> Bool {
        let parts = { (value: String) in value.split(separator: ".").map { Int($0) ?? 0 } }
        return parts(version).lexicographicallyPrecedes(parts(other))
    }

    /// `reader-companion open`, showing a window only if it takes a moment (a Companion that wasn't running).
    private func open() {
        let process = start(companion, ["open"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self, process.isRunning else { return }
            self.showWindow(title: "Starting Reader…", withLog: false)
        }
        process.terminationHandler = { _ in DispatchQueue.main.async { NSApp.terminate(nil) } }
    }

    /// install.sh from the app's Resources: the Companion from the wheel beside it, then `setup`.
    private func install() {
        showWindow(title: wanted.isEmpty ? "Setting up Reader…" : "Setting up Reader (Companion \(wanted))…", withLog: true)
        append("Reader runs your code on this Mac: a Jupyter server in the background, your files in ~/Reader.\nThe first time takes a minute or two: it downloads its own Python.\n\n")
        let process = start(URL(fileURLWithPath: "/bin/sh"), [resources.appendingPathComponent("install.sh").path], streaming: true)
        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self else { return }
                self.spinner.stopAnimation(nil)
                if process.terminationStatus == 0 {
                    self.status.stringValue = "Reader is set up. Open it from Applications or the Dock any time."
                    DispatchQueue.main.asyncAfter(deadline: .now() + 4) { NSApp.terminate(nil) }
                } else {
                    self.status.stringValue = "Setting up didn’t finish. What it said is below; open Reader again to retry."
                }
            }
        }
    }

    // MARK: - Processes

    @discardableResult
    private func start(_ executable: URL, _ arguments: [String], streaming: Bool = false) -> Process {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.currentDirectoryURL = home
        var environment = ProcessInfo.processInfo.environment
        environment["READER_APP"] = Bundle.main.bundlePath
        process.environment = environment
        if streaming {
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
                DispatchQueue.main.async { self?.append(text) }
            }
        }
        do {
            try process.run()
        } catch {
            showWindow(title: "Reader couldn’t start", withLog: true)
            append("\(executable.path): \(error.localizedDescription)\n")
        }
        running = process
        return process
    }

    // MARK: - The window

    private func showWindow(title: String, withLog: Bool) {
        if window == nil {
            let size = NSSize(width: 560, height: withLog ? 360 : 110)
            let made = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            made.title = "Reader"
            made.isReleasedWhenClosed = false
            let content = NSView(frame: NSRect(origin: .zero, size: size))

            spinner.style = .spinning
            spinner.controlSize = .small
            spinner.frame = NSRect(x: 20, y: size.height - 44, width: 18, height: 18)
            spinner.startAnimation(nil)
            content.addSubview(spinner)

            status.frame = NSRect(x: 48, y: size.height - 50, width: size.width - 68, height: 30)
            status.font = .systemFont(ofSize: 13, weight: .medium)
            status.lineBreakMode = .byWordWrapping
            status.maximumNumberOfLines = 2
            content.addSubview(status)

            if withLog {
                let scroll = NSScrollView(frame: NSRect(x: 20, y: 20, width: size.width - 40, height: size.height - 84))
                scroll.hasVerticalScroller = true
                scroll.borderType = .bezelBorder
                log.frame = NSRect(origin: .zero, size: scroll.contentSize)
                log.autoresizingMask = [.width]
                log.isEditable = false
                log.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
                log.textContainerInset = NSSize(width: 6, height: 6)
                scroll.documentView = log
                content.addSubview(scroll)
            }
            made.contentView = content
            made.center()
            window = made
        }
        status.stringValue = title
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func append(_ text: String) {
        log.textStorage?.append(NSAttributedString(string: text, attributes: [.font: log.font as Any, .foregroundColor: NSColor.textColor]))
        log.scrollToEndOfDocument(nil)
    }
}

let app = NSApplication.shared
let reader = Reader()
app.delegate = reader
app.setActivationPolicy(.regular)
app.run()
