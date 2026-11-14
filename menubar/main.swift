// Battery Speed menu bar app.
//
// A thin window onto the background collector: it polls the collector's local
// API and shows charge, state and time left in the menu bar. It reads nothing
// from the battery itself, so the dashboard and the menu bar always agree.

import AppKit

private let baseURL = URL(string: "http://127.0.0.1:4780")!
private let pollSeconds: TimeInterval = 10

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
    case "holding": return "powerplug.fill"
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

// MARK: - App

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private var timer: Timer?
    private var reading: Reading?
    private var reportedPlacement = false

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 3
        return URLSession(configuration: config)
    }()

    func applicationDidFinishLaunching(_ notification: Notification) {
        menu.delegate = self
        statusItem.menu = menu
        statusItem.button?.imagePosition = .imageLeading
        render()
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: pollSeconds, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    // Fetch fresh numbers whenever the menu is opened.
    func menuWillOpen(_ menu: NSMenu) { refresh() }

    private func refresh() {
        let task = session.dataTask(with: baseURL.appendingPathComponent("api/now")) { [weak self] data, _, _ in
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
            lines.append("From the \(w) W adapter: \(watts(r.adapterInMw))")
        } else {
            lines.append("Not plugged in")
        }
        lines.append("Mac is using: \(watts(r.systemLoadMw))")
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
        let open = NSMenuItem(title: "Open Dashboard", action: #selector(openDashboard), keyEquivalent: "d")
        open.target = self
        menu.addItem(open)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit Battery Speed Menu", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
    }

    @objc private func openDashboard() {
        NSWorkspace.shared.open(URL(string: "http://localhost:4780")!)
    }
}

// Top-level code runs on the main thread; say so, since AppDelegate is main-actor bound.
MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory) // menu bar only: no Dock icon
    app.run() // never returns, which keeps `delegate` alive
}
