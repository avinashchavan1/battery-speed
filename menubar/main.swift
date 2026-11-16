// Battery Speed for macOS: the menu bar readout and the app window, in one app.
//
// It is a thin shell around the background collector. The menu bar item polls
// the collector's local API; the window shows the collector's dashboard. The
// app reads nothing from the battery itself, so all three always agree.
//
// Started at login with --background it lives only in the menu bar. Opened
// from Finder, Launchpad or Spotlight it shows the dashboard window, with a
// Dock icon for as long as that window is open.

import AppKit
import EventKit
import IOKit.ps
import UserNotifications
import WebKit

private let baseURL = URL(string: "http://127.0.0.1:4780")!
private let pollSeconds: TimeInterval = 10
private let collectorLabel = "com.batteryspeed.collector"

// MARK: - Model (subset of /api/now)

struct Reading: Decodable {
    struct Adapter: Decodable { let watts: Int? }
    struct Derived: Decodable {
        let state: String
        let label: String
        let headline: String
        let etaMin: Int?
        let etaKind: String?
    }

    let percent: Int
    let fullMah: Double?
    let designMah: Double?
    let cycleCount: Int?
    let batteryPowerMw: Double?
    let adapterInMw: Double?
    let systemLoadMw: Double?
    let adapter: Adapter?
    let derived: Derived
}

// MARK: - Formatting

private func watts(_ mw: Double?) -> String {
    guard let mw else { return "–" }
    return String(format: "%.1f W", abs(mw) / 1000)
}

private func signedWatts(_ mw: Double?) -> String {
    guard let mw else { return "–" }
    let sign = mw <= -50 ? "−" : (mw >= 50 ? "+" : "")
    return sign + watts(mw)
}

private func shortDuration(_ minutes: Int) -> String {
    if minutes < 60 { return "\(max(1, minutes))m" }
    let m = minutes % 60
    return m == 0 ? "\(minutes / 60)h" : "\(minutes / 60)h \(m)m"
}

private func symbolName(for r: Reading) -> String {
    switch r.derived.state {
    case "charging": return "bolt.fill"
    case "draining_on_ac": return "exclamationmark.triangle.fill"
    case "full": return "battery.100percent.bolt"
    case "holding", "connecting": return "powerplug.fill"
    default:
        switch r.percent {
        case ..<13: return "battery.0percent"
        case ..<38: return "battery.25percent"
        case ..<63: return "battery.50percent"
        case ..<88: return "battery.75percent"
        default: return "battery.100percent"
        }
    }
}

// Shown in the window when the collector cannot be reached.
private let offlinePage = """
<!doctype html><meta charset="utf-8">
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; margin: 0; height: 100vh;
         display: grid; place-items: center; background: Canvas; color: CanvasText; }
  main { max-width: 420px; padding: 24px; text-align: center; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0 0 8px; opacity: 0.75; }
  code { font: 13px ui-monospace, monospace; padding: 2px 6px; border-radius: 6px;
         background: color-mix(in srgb, CanvasText 10%, transparent); }
</style>
<main>
  <h1>Battery Speed is starting…</h1>
  <p>The background collector is not answering yet. This window retries on its own.</p>
  <p>If it stays like this, run <code>battery-speed install</code> in Terminal.</p>
</main>
"""

// MARK: - Window dragging

/// The page fills the whole window, title bar included, so the web view would
/// take every click there and the window could not be dragged. This strip sits
/// over the top of the window, where the page leaves empty space, and hands
/// drags and double-clicks back to macOS like a normal title bar.
final class TitleBarDragStrip: NSView {
    static let height: CGFloat = 36 // the page keeps its top 38 px empty in the app

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        if event.clickCount == 2 {
            // Follow System Settings > Desktop & Dock > "Double-click a window's title bar to".
            switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
            case "Minimize": window.performMiniaturize(nil)
            case "None": break
            default: window.performZoom(nil)
            }
        } else {
            window.performDrag(with: event)
        }
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true } // drag even when inactive
    override var mouseDownCanMoveWindow: Bool { true }
}

// MARK: - Notifications

/// An alert as the collector sends it on /notifications.
struct AlertPayload: Decodable {
    let kind: String
    let severity: String
    let title: String
    let body: String
    let ts: Double?

    /// The dashboard section a click on this alert should open.
    var view: String {
        if kind.hasPrefix("hog_") { return "energy" }
        if kind.hasPrefix("weak_charger_") { return "chargers" }
        if kind == "test" { return "alerts" }
        if kind == "digest" { return "summary" }
        return "overview"
    }
}

/// Listens to the collector's notification stream (server-sent events) and
/// hands each alert over. Reconnects on its own if the collector restarts.
final class AlertStream: NSObject, URLSessionDataDelegate {
    private let url = URL(string: "http://127.0.0.1:4780/notifications")!
    private let onAlert: (AlertPayload) -> Void
    private var buffer = Data()
    private var session: URLSession?
    private var running = false

    init(onAlert: @escaping (AlertPayload) -> Void) {
        self.onAlert = onAlert
    }

    func start() {
        guard !running else { return }
        running = true
        connect()
    }

    private func connect() {
        buffer.removeAll()
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 120 // the collector pings every 25 s
        config.timeoutIntervalForResource = .infinity
        session = URLSession(configuration: config, delegate: self, delegateQueue: .main)
        session?.dataTask(with: url).resume()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        buffer.append(data)
        let separator = Data("\n\n".utf8)
        while let range = buffer.range(of: separator) {
            let event = String(decoding: buffer.subdata(in: buffer.startIndex..<range.lowerBound), as: UTF8.self)
            buffer.removeSubrange(buffer.startIndex..<range.upperBound)
            let lines = event.split(separator: "\n")
            guard lines.contains("event: notify"),
                  let line = lines.first(where: { $0.hasPrefix("data: ") }),
                  let alert = try? JSONDecoder().decode(AlertPayload.self, from: Data(line.dropFirst(6).utf8))
            else { continue }
            onAlert(alert)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        session.invalidateAndCancel()
        // The collector stopped or restarted: try again shortly.
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in self?.connect() }
    }
}

// MARK: - App

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate, WKNavigationDelegate,
    UNUserNotificationCenterDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private var timer: Timer?
    private var reading: Reading?
    private var window: NSWindow?
    private var webView: WKWebView?
    private var showingOfflinePage = false
    private var reportedPlacement = false
    private var reportedDashboard = false
    private var alertStream: AlertStream?
    private let eventStore = EKEventStore()
    private var calendarTimer: Timer?
    private var warnedEvents = Set<String>()
    private var pendingView: String? // section to show once the window has loaded

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 3
        return URLSession(configuration: config)
    }()

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMainMenu()
        menu.delegate = self
        statusItem.menu = menu
        statusItem.button?.imagePosition = .imageLeading
        render()
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: pollSeconds, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
        watchPowerSource()
        startNotifications()
        startCalendarWatch()
        // Launched by hand rather than at login: show the window straight away.
        if !CommandLine.arguments.contains("--background") { showDashboard(view: nil) }
    }

    // Opening the app again (Finder, Launchpad, Spotlight, the Dock) shows the window.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showDashboard(view: nil)
        return false
    }

    // Closing the window leaves the menu bar readout running.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    // Fetch fresh numbers whenever the menu is opened.
    func menuWillOpen(_ menu: NSMenu) { refresh() }

    // MARK: Dashboard window

    @objc func openDashboard() { showDashboard(view: nil) }

    /// Shows the window, optionally on one section ("energy", "chargers", ...).
    func showDashboard(view: String?) {
        if window == nil { buildWindow() }
        NSApp.setActivationPolicy(.regular) // Dock icon while the window is open
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        // Reload if the page is not the live dashboard (first open, or the offline page).
        if webView?.url?.host != baseURL.host || showingOfflinePage {
            pendingView = view
            loadDashboard()
        } else if let view {
            webView?.evaluateJavaScript("location.hash = '#\(view)'")
        }
    }

    // MARK: Calendar warnings

    /// Every 5 minutes, and just after the power source changes: if calendar
    /// warnings are switched on and an event starts within the hour that the
    /// battery will not last through, raise an alert. Event details are only
    /// sent to the local collector, never off this computer.
    private func startCalendarWatch() {
        calendarTimer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.checkCalendar() }
        }
        checkCalendarSoon()
    }

    func checkCalendarSoon() {
        // Give the fresh battery reading a moment to arrive first.
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in self?.checkCalendar() }
    }

    private func checkCalendar() {
        struct Settings: Decodable { let calendar: Bool? }
        session.dataTask(with: URL(string: "http://127.0.0.1:4780/api/settings")!) { [weak self] data, _, _ in
            let on = data.flatMap { try? JSONDecoder().decode(Settings.self, from: $0) }?.calendar ?? false
            guard on else { return }
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.withCalendarAccess { self?.warnIfBatteryShort() } }
            }
        }.resume()
    }

    /// Runs `then` once calendar access is granted, asking the first time.
    private func withCalendarAccess(_ then: @escaping @MainActor () -> Void) {
        let status = EKEventStore.authorizationStatus(for: .event)
        let granted: (Bool, Error?) -> Void = { ok, _ in
            NSLog("calendar access: %@", ok ? "granted" : "not granted")
            guard ok else { return }
            DispatchQueue.main.async { MainActor.assumeIsolated { then() } }
        }
        if #available(macOS 14.0, *) {
            if status == .fullAccess { then(); return }
            if status == .notDetermined { eventStore.requestFullAccessToEvents(completion: granted) }
        } else {
            if status == .authorized { then(); return }
            if status == .notDetermined { eventStore.requestAccess(to: .event, completion: granted) }
        }
    }

    private func warnIfBatteryShort() {
        guard let r = reading, r.derived.etaKind == "empty", let eta = r.derived.etaMin else { return }
        let now = Date()
        let window = now.addingTimeInterval(3600) // events starting within the hour
        let predicate = eventStore.predicateForEvents(withStart: now, end: window.addingTimeInterval(4 * 3600), calendars: nil)
        guard let event = eventStore.events(matching: predicate)
            .filter({ !$0.isAllDay && $0.startDate >= now && $0.startDate <= window })
            .min(by: { $0.startDate < $1.startDate }) else { return }

        let minutesUntilEnd = event.endDate.timeIntervalSince(now) / 60
        guard Double(eta) < minutesUntilEnd else { return } // the battery will last: nothing to say

        let key = String(((event.calendarItemIdentifier) + "\(Int(event.startDate.timeIntervalSince1970))")
            .filter { $0.isLetter || $0.isNumber }.prefix(80))
        guard !warnedEvents.contains(key) else { return }
        warnedEvents.insert(key)

        let start = DateFormatter.localizedString(from: event.startDate, dateStyle: .none, timeStyle: .short)
        let end = DateFormatter.localizedString(from: event.endDate, dateStyle: .none, timeStyle: .short)
        let name = (event.title ?? "").isEmpty ? "your next event" : "\u{201C}\(event.title!)\u{201D}"
        let alert: [String: String] = [
            "kind": "calendar_\(key)",
            "title": "Battery won't last through \(name)",
            "body": "It starts at \(start) and runs until \(end). At the current rate the battery lasts about " +
                "\(shortDuration(eta)), so it would run out before the end. Plug in before it starts.",
        ]
        var request = URLRequest(url: URL(string: "http://127.0.0.1:4780/api/alerts/raise")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: alert)
        session.dataTask(with: request) { _, _, error in
            if let error { NSLog("could not raise calendar alert: %@", error.localizedDescription) }
            else { NSLog("raised calendar alert for an event at %@", start) }
        }.resume()
    }

    // MARK: Notifications

    /// Alerts are posted by this app, so they carry its icon and name, and a
    /// click opens Battery Speed. macOS asks once for permission.
    private func startNotifications() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { granted, error in
            if let error { NSLog("notification permission request failed: %@", error.localizedDescription) }
            NSLog("notification permission: %@", granted ? "granted" : "not granted")
            DispatchQueue.main.async { [weak self] in
                // Only take over delivery once allowed; until then the collector
                // keeps using the system's own notifications.
                guard granted, let self else { return }
                self.alertStream = AlertStream { [weak self] alert in self?.post(alert) }
                self.alertStream?.start()
            }
        }
    }

    private func post(_ alert: AlertPayload) {
        let content = UNMutableNotificationContent()
        content.title = alert.title
        content.body = alert.body
        content.sound = alert.severity == "good" ? nil : .default
        content.threadIdentifier = alert.kind
        content.userInfo = ["view": alert.view]
        let id = "\(alert.kind)-\(Int(alert.ts ?? Date().timeIntervalSince1970 * 1000))"
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { error in
            if let error { NSLog("could not post notification: %@", error.localizedDescription) }
            else { NSLog("posted notification: %@", alert.title) }
        }
    }

    // Show alerts even while the window is in front.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }

    // A click on an alert opens the app on the section it is about.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let view = response.notification.request.content.userInfo["view"] as? String
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                (NSApp.delegate as? AppDelegate)?.showDashboard(view: view)
            }
            completionHandler()
        }
    }

    private func buildWindow() {
        let config = WKWebViewConfiguration()
        // The page's sound effects are deliberate; do not require a click per sound.
        config.mediaTypesRequiringUserActionForPlayback = []
        // The page checks for this name to know it is inside the app window.
        config.applicationNameForUserAgent = "BatterySpeedApp/1"
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground") // lets the sidebar material show through
        web.allowsMagnification = false

        // The system sidebar material fills the window; the page paints its
        // content pane over it and leaves the sidebar area clear.
        let material = NSVisualEffectView()
        material.material = .sidebar
        material.blendingMode = .behindWindow
        material.state = .followsWindowActiveState
        web.frame = material.bounds
        web.autoresizingMask = [.width, .height]
        material.addSubview(web)

        let strip = TitleBarDragStrip(frame: NSRect(
            x: 0, y: material.bounds.height - TitleBarDragStrip.height,
            width: material.bounds.width, height: TitleBarDragStrip.height
        ))
        strip.autoresizingMask = [.width, .minYMargin] // stays pinned to the top as the window resizes
        material.addSubview(strip) // above the web view; the window buttons still sit above both

        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 960, height: 680),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        win.title = "Battery Speed"
        win.titleVisibility = .hidden
        win.titlebarAppearsTransparent = true // window controls sit over the sidebar
        win.minSize = NSSize(width: 680, height: 460)
        win.isReleasedWhenClosed = false
        win.delegate = self
        win.contentView = material
        win.center()
        win.setFrameAutosaveName("BatterySpeedMain") // remember size and position

        window = win
        webView = web
    }

    private func loadDashboard() {
        showingOfflinePage = false
        var url = baseURL
        if let view = pendingView, let withView = URL(string: "#\(view)", relativeTo: baseURL) {
            url = withView.absoluteURL
        }
        pendingView = nil
        webView?.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5))
    }

    @objc private func reloadDashboard() { loadDashboard() }

    func windowWillClose(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory) // back to menu bar only
    }

    // The collector is not answering: show a holding page, nudge the collector, retry.
    private func dashboardFailed() {
        showingOfflinePage = true
        webView?.loadHTMLString(offlinePage, baseURL: nil)
        startCollector()
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            guard let self, self.showingOfflinePage, self.window?.isVisible == true else { return }
            self.loadDashboard()
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if !showingOfflinePage { dashboardFailed() }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !showingOfflinePage, !reportedDashboard else { return }
        reportedDashboard = true
        // One line in the log confirming the dashboard really rendered in the window.
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            let script = "document.title + ' | ' + (document.getElementById('percent')?.textContent ?? '?') + '% | ' + (document.getElementById('headline')?.textContent ?? '?') + ' | native chrome: ' + document.documentElement.classList.contains('in-app')"
            self?.webView?.evaluateJavaScript(script) { result, _ in
                NSLog("dashboard window loaded: %@ | title bar click goes to: %@",
                      (result as? String) ?? "no result", self?.titleBarHitClass() ?? "?")
            }
        }
    }

    /// Which view a click in the middle of the title bar area reaches, asked of
    /// the whole window frame (so the title bar's own views are included).
    func titleBarHitClass() -> String {
        guard let window, let frame = window.contentView?.superview else { return "no window" }
        let point = NSPoint(x: frame.bounds.midX, y: frame.bounds.maxY - 18)
        return frame.hitTest(point).map { String(describing: type(of: $0)) } ?? "nothing"
    }

    // Links that leave the dashboard open in the default browser, not in this window.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
        if let url = navigationAction.request.url, let host = url.host, host != baseURL.host,
           navigationAction.navigationType == .linkActivated {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        } else {
            decisionHandler(.allow)
        }
    }

    /// Asks launchd to start the installed collector, in case it is not running.
    private func startCollector() {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = ["kickstart", "gui/\(getuid())/\(collectorLabel)"]
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        try? task.run()
    }

    // MARK: Menu bar item

    /// macOS announces every power source change (plugging in, unplugging, new
    /// battery figures) the moment it happens. Each one triggers a fresh read,
    /// so the menu bar and the window update at once instead of on the next poll.
    private func watchPowerSource() {
        let context = Unmanaged.passUnretained(self).toOpaque()
        let callback: IOPowerSourceCallbackType = { context in
            guard let context else { return }
            let delegate = Unmanaged<AppDelegate>.fromOpaque(context).takeUnretainedValue()
            MainActor.assumeIsolated {
                delegate.refresh(fresh: true)
                delegate.checkCalendarSoon() // unplugging is when a calendar warning matters most
            }
        }
        guard let source = IOPSNotificationCreateRunLoopSource(callback, context)?.takeRetainedValue() else { return }
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .defaultMode)
    }

    private func refresh(fresh: Bool = false) {
        // `fresh` asks the collector to read the battery now rather than reuse its last reading.
        let url = URL(string: fresh ? "http://127.0.0.1:4780/api/now?fresh=1" : "http://127.0.0.1:4780/api/now")!
        let task = session.dataTask(with: url) { [weak self] data, _, _ in
            let decoded = data.flatMap { try? JSONDecoder().decode(Reading.self, from: $0) }
            Task { @MainActor in
                self?.reading = decoded
                self?.render()
            }
        }
        task.resume()
    }

    private func render() {
        guard let button = statusItem.button else { return }

        guard let r = reading else {
            button.image = NSImage(systemSymbolName: "battery.0percent", accessibilityDescription: "Battery")
            button.title = " –"
            button.toolTip = "Battery Speed: the collector is not running"
            rebuildMenu(lines: ["The collector is not running."], headline: "No data")
            return
        }

        var title = " \(r.percent)%"
        if let eta = r.derived.etaMin, r.derived.etaKind != nil {
            title += " · \(shortDuration(eta))"
        }
        button.image = NSImage(systemSymbolName: symbolName(for: r), accessibilityDescription: r.derived.label)
        button.title = title
        button.toolTip = r.derived.headline

        var lines: [String] = []
        if let eta = r.derived.etaMin, let kind = r.derived.etaKind {
            lines.append("\(shortDuration(eta)) until \(kind == "empty" ? "empty" : "full")")
        }
        if let w = r.adapter?.watts {
            lines.append("From the \(w) W charger: \(watts(r.adapterInMw))")
        } else if r.adapter != nil {
            lines.append("Charger connected")
        } else {
            lines.append("Not plugged in")
        }
        if r.systemLoadMw != nil { lines.append("Mac is using: \(watts(r.systemLoadMw))") }
        lines.append("Battery flow: \(signedWatts(r.batteryPowerMw))")
        if let full = r.fullMah, let design = r.designMah, design > 0 {
            let cycles = r.cycleCount.map { " · \($0) cycles" } ?? ""
            lines.append("Health: \(Int((full / design * 100).rounded()))%\(cycles)")
        }
        rebuildMenu(lines: lines, headline: "\(r.percent)% · \(r.derived.headline)")
        reportPlacementOnce(title: title)
    }

    // Logs once where the item landed, so a hidden item (for example pushed
    // behind the notch by a crowded menu bar) can be diagnosed from the log.
    private func reportPlacementOnce(title: String) {
        guard !reportedPlacement else { return }
        reportedPlacement = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let window = self?.statusItem.button?.window else { return }
            let shown = window.occlusionState.contains(.visible)
            NSLog("status item title=\"%@\" frame=%@ visible=%@", title, NSStringFromRect(window.frame), shown ? "yes" : "no")
        }
    }

    private func rebuildMenu(lines: [String], headline: String) {
        menu.removeAllItems()

        let head = NSMenuItem(title: headline, action: nil, keyEquivalent: "")
        head.isEnabled = false
        menu.addItem(head)
        for line in lines {
            let item = NSMenuItem(title: line, action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        }

        menu.addItem(.separator())
        let open = NSMenuItem(title: "Open Battery Speed", action: #selector(openDashboard), keyEquivalent: "d")
        open.target = self
        menu.addItem(open)
        let browser = NSMenuItem(title: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "")
        browser.target = self
        menu.addItem(browser)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Battery Speed", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    }

    @objc private func openInBrowser() {
        NSWorkspace.shared.open(URL(string: "http://localhost:4780")!)
    }

    // MARK: Main menu (shown while the window is open)

    private func buildMainMenu() {
        let main = NSMenu()

        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Battery Speed", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Battery Speed", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Battery Speed", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let fileMenu = NSMenu(title: "File")
        fileMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")

        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        let viewMenu = NSMenu(title: "View")
        let reload = viewMenu.addItem(withTitle: "Reload", action: #selector(reloadDashboard), keyEquivalent: "r")
        reload.target = self
        let inBrowser = viewMenu.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "")
        inBrowser.target = self

        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")

        for submenu in [appMenu, fileMenu, editMenu, viewMenu, windowMenu] {
            let item = NSMenuItem()
            item.submenu = submenu
            main.addItem(item)
        }
        NSApp.mainMenu = main
        NSApp.windowsMenu = windowMenu
    }
}

// Messages go to ~/Library/Logs/Battery Speed.log however the app was started
// (at login, from Finder, from a notification), so problems can be looked up.
private func redirectLogToFile() {
    let logs = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs")
    try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
    freopen(logs.appendingPathComponent("Battery Speed.log").path, "a", stderr)
}
redirectLogToFile()

// Top-level code runs on the main thread; say so, since AppDelegate is main-actor bound.
MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory) // menu bar only until the window is asked for
    app.run() // never returns, which keeps `delegate` alive
}
