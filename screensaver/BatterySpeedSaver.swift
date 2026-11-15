// Battery Speed screen saver.
//
// Shows the charge, what the battery is doing and the time left, on a black
// screen. Built to cost as little power as a screen saver can:
//   - a pure black background, so most of the display stays dark
//   - dim text, and nothing that animates continuously
//   - one redraw every 30 seconds; between redraws nothing runs
//   - the text moves to a new spot on each redraw, to avoid burn-in
//
// It reads the battery straight from the system, so it works on its own. When
// the Battery Speed collector is running it adds the richer detail from there.

import IOKit
import IOKit.ps
import ScreenSaver

private let refreshSeconds: TimeInterval = 30
private let collectorURL = URL(string: "http://127.0.0.1:4780/api/now")!

/// What the saver draws.
struct SaverReading {
    enum Tone { case charging, draining, battery, low, neutral }

    var percent: Int
    var status: String
    var detail: String?
    var tone: Tone
}

private func duration(_ minutes: Int) -> String {
    if minutes < 60 { return "\(max(1, minutes)) min" }
    let m = minutes % 60
    return m == 0 ? "\(minutes / 60) h" : "\(minutes / 60) h \(m) min"
}

private func describe(state: String, percent: Int, etaMinutes: Int?) -> (String, SaverReading.Tone) {
    let left = etaMinutes.map { " · \(duration($0)) left" } ?? ""
    switch state {
    case "charging":
        return ("Charging" + (etaMinutes.map { " · \(duration($0)) until full" } ?? ""), .charging)
    case "draining_on_ac":
        return ("Plugged in, still draining" + left, .draining)
    case "full":
        return ("Fully charged", .charging)
    case "holding":
        return ("Plugged in, not charging", .neutral)
    case "connecting":
        return ("Charger connected", .charging)
    default:
        return ("On battery" + left, percent <= 20 ? .low : .battery)
    }
}

// MARK: - Reading the battery

/// Straight from the system: always available, no collector needed.
private func readSystem() -> SaverReading? {
    guard let blob = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
          let sources = IOPSCopyPowerSourcesList(blob)?.takeRetainedValue() as? [CFTypeRef] else { return nil }

    for source in sources {
        guard let info = IOPSGetPowerSourceDescription(blob, source)?.takeUnretainedValue() as? [String: Any],
              info[kIOPSTypeKey] as? String == kIOPSInternalBatteryType,
              let current = info[kIOPSCurrentCapacityKey] as? Int,
              let max = info[kIOPSMaxCapacityKey] as? Int, max > 0 else { continue }

        let percent = Int((Double(current) / Double(max) * 100).rounded())
        let onCharger = info[kIOPSPowerSourceStateKey] as? String == kIOPSACPowerValue
        let charging = info[kIOPSIsChargingKey] as? Bool ?? false
        let charged = info[kIOPSIsChargedKey] as? Bool ?? false
        let toEmpty = (info[kIOPSTimeToEmptyKey] as? Int).flatMap { $0 > 0 ? $0 : nil }
        let toFull = (info[kIOPSTimeToFullChargeKey] as? Int).flatMap { $0 > 0 ? $0 : nil }

        let state: String
        if !onCharger { state = "discharging" }
        else if charged { state = "full" }
        else if charging { state = "charging" }
        else if (batteryCurrent() ?? 0) < -40 { state = "draining_on_ac" }
        else { state = "holding" }

        let eta = state == "charging" ? toFull : (state == "discharging" || state == "draining_on_ac") ? toEmpty : nil
        let (status, tone) = describe(state: state, percent: percent, etaMinutes: eta)
        return SaverReading(percent: percent, status: status, detail: nil, tone: tone)
    }
    return nil
}

/// Current into (+) or out of (−) the battery, in mA, where the system allows reading it.
private func batteryCurrent() -> Int? {
    let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("AppleSmartBattery"))
    guard service != 0 else { return nil }
    defer { IOObjectRelease(service) }
    let value = IORegistryEntryCreateCFProperty(service, "InstantAmperage" as CFString, kCFAllocatorDefault, 0)?
        .takeRetainedValue() as? NSNumber
    return value.map { Int($0.int64Value) } // int64Value turns the unsigned wrap back into a negative
}

/// The collector's reading: adds learned time estimates and power figures.
private struct CollectorReading: Decodable {
    struct Derived: Decodable {
        let state: String
        let etaMin: Int?
    }
    struct Adapter: Decodable { let watts: Int? }

    let percent: Int
    let adapterInMw: Double?
    let systemLoadMw: Double?
    let adapter: Adapter?
    let derived: Derived

    var reading: SaverReading {
        let (status, tone) = describe(state: derived.state, percent: percent, etaMinutes: derived.etaMin)
        var detail: String?
        if let load = systemLoadMw {
            let using = String(format: "Laptop using %.0f W", load / 1000)
            if let input = adapterInMw, input > 50 {
                detail = String(format: "Charger giving %.0f W · ", input / 1000) + using.prefix(1).lowercased() + using.dropFirst()
            } else {
                detail = using
            }
        }
        return SaverReading(percent: percent, status: status, detail: detail, tone: tone)
    }
}

// MARK: - The view

@objc(BatterySpeedSaverView)
final class BatterySpeedSaverView: ScreenSaverView {
    /// What is on screen. Settable so the look can be checked without a battery.
    var reading: SaverReading?
    private var anchor = CGPoint(x: 0.5, y: 0.5) // where the text block sits, as a fraction of free space
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 2
        return URLSession(configuration: config)
    }()

    override init?(frame: NSRect, isPreview: Bool) {
        super.init(frame: frame, isPreview: isPreview)
        animationTimeInterval = refreshSeconds
        reading = readSystem()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        animationTimeInterval = refreshSeconds
    }

    override var hasConfigureSheet: Bool { false }
    override var configureSheet: NSWindow? { nil }

    override func startAnimation() {
        super.startAnimation()
        refresh()
    }

    // Called once per `animationTimeInterval`: the only work this saver does.
    override func animateOneFrame() {
        anchor = CGPoint(x: .random(in: 0...1), y: .random(in: 0...1))
        refresh()
        needsDisplay = true
    }

    private func refresh() {
        if let system = readSystem() { reading = system }
        // Ask the collector for the richer reading; quietly keep the system one if it is not there.
        session.dataTask(with: collectorURL) { [weak self] data, _, _ in
            guard let data, let collector = try? JSONDecoder().decode(CollectorReading.self, from: data) else { return }
            DispatchQueue.main.async {
                self?.reading = collector.reading
                self?.needsDisplay = true
            }
        }.resume()
    }

    override func draw(_ rect: NSRect) {
        NSColor.black.setFill()
        bounds.fill()
        guard let reading else { return }

        // Sizes follow the screen height, so the small preview in Settings matches full screen.
        let unit = bounds.height / 900
        let white = { (alpha: CGFloat) in NSColor(white: 1, alpha: alpha) }
        let accent: NSColor
        switch reading.tone {
        case .charging: accent = NSColor(srgbRed: 0.19, green: 0.82, blue: 0.35, alpha: 0.9)
        case .draining: accent = NSColor(srgbRed: 1.0, green: 0.62, blue: 0.04, alpha: 0.9)
        case .low: accent = NSColor(srgbRed: 1.0, green: 0.27, blue: 0.23, alpha: 0.9)
        case .battery, .neutral: accent = white(0.7)
        }

        let percent = NSAttributedString(string: "\(reading.percent)%", attributes: [
            .font: NSFont.systemFont(ofSize: 148 * unit, weight: .thin),
            .foregroundColor: white(0.86),
            .kern: -3 * unit,
        ])
        let status = NSAttributedString(string: reading.status, attributes: [
            .font: NSFont.systemFont(ofSize: 25 * unit, weight: .regular),
            .foregroundColor: white(0.62),
        ])
        var small = [reading.detail, Self.clock.string(from: Date())].compactMap { $0 }.joined(separator: "   ·   ")
        if isPreview { small = Self.clock.string(from: Date()) }
        let footer = NSAttributedString(string: small, attributes: [
            .font: NSFont.systemFont(ofSize: 17 * unit, weight: .regular),
            .foregroundColor: white(0.36),
        ])

        let barWidth = 380 * unit
        let barHeight = max(2, 5 * unit)
        let gap = 16 * unit
        let blockWidth = max(percent.size().width, status.size().width, footer.size().width, barWidth)
        let blockHeight = percent.size().height + barHeight + status.size().height + footer.size().height + gap * 3

        // Somewhere inside the margins; a new place each refresh.
        let margin = 70 * unit
        let x = margin + anchor.x * max(0, bounds.width - blockWidth - margin * 2)
        var y = margin + anchor.y * max(0, bounds.height - blockHeight - margin * 2)

        footer.draw(at: CGPoint(x: x, y: y))
        y += footer.size().height + gap
        status.draw(at: CGPoint(x: x, y: y))
        y += status.size().height + gap

        // The level bar: a track with the charged part filled in.
        let track = NSRect(x: x, y: y, width: barWidth, height: barHeight)
        white(0.14).setFill()
        NSBezierPath(roundedRect: track, xRadius: barHeight / 2, yRadius: barHeight / 2).fill()
        var fill = track
        fill.size.width = barWidth * CGFloat(min(100, max(0, reading.percent))) / 100
        accent.setFill()
        NSBezierPath(roundedRect: fill, xRadius: barHeight / 2, yRadius: barHeight / 2).fill()
        y += barHeight + gap * 0.4

        percent.draw(at: CGPoint(x: x - 6 * unit, y: y)) // optical alignment with the bar's left edge
    }

    private static let clock: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("EEE d MMM  jm")
        return formatter
    }()
}
