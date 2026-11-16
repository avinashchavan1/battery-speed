import Foundation
import Observation
import UIKit

/// One saved reading. iOS only lets apps see the level and whether it is charging.
struct Sample: Codable, Identifiable {
    var id: Date { time }
    let time: Date
    let percent: Int
    let charging: Bool
    let plugged: Bool
}

enum PowerState: String {
    case charging, full, onBattery, unknown

    var label: String {
        switch self {
        case .charging: "Charging"
        case .full: "Full"
        case .onBattery: "On battery"
        case .unknown: "Unknown"
        }
    }
}

/// Watches the battery while the app runs, keeps history on the phone, and
/// estimates time left from how fast the level has been moving.
@MainActor
@Observable
final class BatteryMonitor {
    private(set) var percent: Int = 0
    private(set) var state: PowerState = .unknown
    private(set) var lowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled
    private(set) var history: [Sample] = []
    /// True on the Simulator, which has no battery; the app then shows sample data.
    let demo: Bool

    private let store = HistoryStore()

    init() {
        demo = ProcessInfo.processInfo.arguments.contains("-demo")
            || ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"] != nil
        history = demo ? Self.demoHistory() : store.load()
        UIDevice.current.isBatteryMonitoringEnabled = true
        let center = NotificationCenter.default
        for name in [UIDevice.batteryLevelDidChangeNotification, UIDevice.batteryStateDidChangeNotification,
                     .NSProcessInfoPowerStateDidChange] {
            center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.refresh() }
            }
        }
        refresh()
    }

    func refresh() {
        lowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled
        if demo {
            let last = history.last!
            percent = last.percent
            state = .onBattery
            return
        }
        let device = UIDevice.current
        let level = device.batteryLevel
        guard level >= 0 else { state = .unknown; return }
        percent = Int((level * 100).rounded())
        switch device.batteryState {
        case .charging: state = .charging
        case .full: state = .full
        case .unplugged: state = .onBattery
        default: state = .unknown
        }
        record()
    }

    private func record() {
        let sample = Sample(time: .now, percent: percent, charging: state == .charging,
                            plugged: state == .charging || state == .full)
        if let last = history.last, last.percent == sample.percent, last.plugged == sample.plugged,
           sample.time.timeIntervalSince(last.time) < 600 { return }
        history.append(sample)
        history.removeAll { $0.time < Date.now.addingTimeInterval(-30 * 86_400) }
        store.save(history)
    }

    // MARK: Estimates

    /// Percent per minute over the current stretch of charging or discharging,
    /// once there are at least two levels 10 minutes or more apart.
    var ratePerMinute: Double? {
        let plugged = state == .charging || state == .full
        let stretch = history.reversed().prefix { $0.plugged == plugged && $0.time > Date.now.addingTimeInterval(-3 * 3600) }
        guard let newest = stretch.first, let oldest = stretch.last else { return nil }
        let minutes = newest.time.timeIntervalSince(oldest.time) / 60
        let change = Double(newest.percent - oldest.percent)
        guard minutes >= 10, change != 0 else { return nil }
        return change / minutes
    }

    /// Minutes until empty (on battery) or full (charging), or nil if not known yet.
    var minutesLeft: Int? {
        guard let rate = ratePerMinute else { return nil }
        if state == .onBattery, rate < 0 { return Int(Double(percent) / -rate) }
        if state == .charging, rate > 0 {
            // Up to 80% at today's speed, then about half as fast.
            let fast = max(0, 80 - Double(percent)) / rate
            let slow = (100 - max(80, Double(percent))) / (rate * 0.5)
            return Int(fast + slow)
        }
        return nil
    }

    /// Minutes until the level reaches `target`, at the current rate.
    func minutes(until target: Int) -> Double? {
        guard let rate = ratePerMinute, rate != 0 else { return nil }
        let minutes = Double(target - percent) / rate
        return minutes > 0 ? minutes : nil
    }

    // MARK: Demo data for the Simulator

    private static func demoHistory() -> [Sample] {
        var samples: [Sample] = []
        let start = Date.now.addingTimeInterval(-6 * 3600)
        var level = 38.0
        for step in 0...72 { // every 5 minutes for 6 hours
            let time = start.addingTimeInterval(Double(step) * 300)
            let plugged = step < 30
            level += plugged ? 1.6 : -0.45
            level = min(level, 100)
            samples.append(Sample(time: time, percent: Int(level), charging: plugged && level < 100, plugged: plugged))
        }
        return samples
    }
}

/// History in a small JSON file in the app's own folder. It never leaves the phone.
struct HistoryStore {
    private var url: URL {
        let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder.appendingPathComponent("history.json")
    }

    func load() -> [Sample] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([Sample].self, from: data)) ?? []
    }

    func save(_ samples: [Sample]) {
        if let data = try? JSONEncoder().encode(samples) { try? data.write(to: url, options: .atomic) }
    }
}

func duration(minutes: Int) -> String {
    if minutes < 1 { return "under 1 min" }
    if minutes < 60 { return "\(minutes) min" }
    if minutes > 24 * 60 { return "over 24 h" }
    let h = minutes / 60, m = minutes % 60
    return m == 0 ? "\(h) h" : "\(h) h \(m) min"
}
