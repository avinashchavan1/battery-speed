import Charts
import SwiftUI

struct ContentView: View {
    let monitor: BatteryMonitor

    var body: some View {
        TabView {
            OverviewView(monitor: monitor).tabItem { Label("Overview", systemImage: "battery.75percent") }
            HistoryView(monitor: monitor).tabItem { Label("History", systemImage: "chart.xyaxis.line") }
            HealthView().tabItem { Label("Health", systemImage: "heart") }
            RemindersView(monitor: monitor).tabItem { Label("Reminders", systemImage: "bell") }
        }
    }
}

// MARK: - Overview

struct OverviewView: View {
    let monitor: BatteryMonitor

    private var color: Color {
        switch monitor.state {
        case .charging, .full: .green
        case .onBattery: monitor.percent <= 10 ? .red : monitor.percent <= 20 ? .orange : .accentColor
        case .unknown: .secondary
        }
    }

    private var headline: String {
        switch monitor.state {
        case .charging: "Charging"
        case .full: "Fully charged"
        case .onBattery: monitor.percent <= 20 ? "Running low" : "Running on battery"
        case .unknown: "Battery level not available"
        }
    }

    private var meaning: String {
        let time = monitor.minutesLeft.map { duration(minutes: $0) }
        switch monitor.state {
        case .charging:
            return "The charger is filling the battery." + (time.map { " At this speed it is full in about \($0)." } ?? "")
        case .full:
            return "The battery is full and the charger is running the phone."
        case .onBattery:
            return "Nothing is plugged in, so the battery is powering everything." +
                (time.map { " At the rate it has been going down, it lasts about \($0)." } ?? "")
        case .unknown:
            return "iOS isn't reporting the battery right now."
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if monitor.demo {
                    Section {
                        Label("Sample data: the Simulator has no battery. On an iPhone this shows the real battery.",
                              systemImage: "info.circle")
                            .font(.footnote)
                    }
                }
                Section {
                    VStack(alignment: .leading, spacing: 12) {
                        Label(headline, systemImage: symbol)
                            .font(.headline)
                            .foregroundStyle(color)
                        HStack(alignment: .firstTextBaseline) {
                            Text("\(monitor.percent)")
                                .font(.system(size: 60, weight: .bold, design: .rounded))
                                + Text("%").font(.system(size: 28, weight: .semibold, design: .rounded))
                            Spacer()
                            if let minutes = monitor.minutesLeft {
                                VStack(alignment: .trailing) {
                                    Text(duration(minutes: minutes)).font(.title2.weight(.semibold))
                                    Text(monitor.state == .charging ? "until full" : "remaining")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                        ProgressView(value: Double(monitor.percent), total: 100)
                            .tint(color)
                    }
                    .padding(.vertical, 6)
                } footer: {
                    Text(meaning).font(.body).foregroundStyle(.primary).padding(.top, 6)
                }

                Section {
                    LabeledContent("Charger", value: monitor.state == .charging || monitor.state == .full ? "Connected" : "Not connected")
                    LabeledContent("Speed", value: rateText)
                    LabeledContent("Low Power Mode", value: monitor.lowPowerMode ? "On" : "Off")
                } header: {
                    Text("Details")
                } footer: {
                    Text("iOS only tells apps the battery level and whether it is charging. It does not share watts, charger power, temperature or which apps use the most energy; for those, see Settings > Battery.")
                }
            }
            .navigationTitle("Battery Speed")
            .refreshable { monitor.refresh() }
        }
    }

    private var symbol: String {
        switch monitor.state {
        case .charging: "bolt.fill"
        case .full: "checkmark.circle.fill"
        case .onBattery: monitor.percent <= 20 ? "battery.25percent" : "battery.75percent"
        case .unknown: "questionmark.circle"
        }
    }

    private var rateText: String {
        guard let rate = monitor.ratePerMinute else { return "Measuring…" }
        let perHour = abs(rate * 60)
        let direction = rate > 0 ? "gaining" : "losing"
        return String(format: "%@ %.0f%% an hour", direction.capitalized, perHour)
    }
}

// MARK: - History

struct HistoryView: View {
    let monitor: BatteryMonitor
    @State private var hours = 24

    private var points: [Sample] {
        monitor.history.filter { $0.time > Date.now.addingTimeInterval(Double(-hours) * 3600) }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("Range", selection: $hours) {
                        Text("6 hours").tag(6)
                        Text("24 hours").tag(24)
                        Text("7 days").tag(168)
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
                Section("Charge level") {
                    if points.count < 2 {
                        Text("Collecting readings…").foregroundStyle(.secondary)
                    } else {
                        Chart(points) { sample in
                            AreaMark(x: .value("Time", sample.time), y: .value("Charge", sample.percent))
                                .foregroundStyle(.green.opacity(0.12))
                            LineMark(x: .value("Time", sample.time), y: .value("Charge", sample.percent))
                                .foregroundStyle(.green)
                        }
                        .chartYScale(domain: 0...100)
                        .chartYAxis { AxisMarks(values: [0, 25, 50, 75, 100]) }
                        .frame(height: 200)
                        .padding(.vertical, 8)
                    }
                }
                Section {
                    LabeledContent("Charge used", value: "\(used)%")
                    LabeledContent("Charge added", value: "\(added)%")
                    LabeledContent("Lowest level", value: points.map(\.percent).min().map { "\($0)%" } ?? "–")
                } header: {
                    Text("In this period")
                } footer: {
                    Text("iOS lets apps read the battery only while they are open, plus a few times a day in the background, so history has gaps. It is kept on this phone only.")
                }
            }
            .navigationTitle("History")
        }
    }

    private var used: Int { zip(points, points.dropFirst()).reduce(0) { $0 + max(0, $1.0.percent - $1.1.percent) } }
    private var added: Int { zip(points, points.dropFirst()).reduce(0) { $0 + max(0, $1.1.percent - $1.0.percent) } }
}

// MARK: - Health

struct HealthView: View {
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Label("Open Settings, then Battery, then Battery Health", systemImage: "gear")
                } header: {
                    Text("Where to find battery health")
                } footer: {
                    Text("Apple shows maximum capacity and cycle count in the Settings app, but does not let other apps read them, so Battery Speed can't show them here.")
                }
                Section("Habits that slow battery wear") {
                    Label("Unplug around 80% when you can", systemImage: "battery.75percent")
                    Label("Avoid charging while the phone is hot", systemImage: "thermometer.sun")
                    Label("Let Optimized Charging pause at 80% overnight", systemImage: "moon.zzz")
                }
            }
            .navigationTitle("Health")
        }
    }
}

// MARK: - Reminders

struct RemindersView: View {
    let monitor: BatteryMonitor
    @State private var unplugAt = Reminders.unplugAt
    @State private var lowReminder = Reminders.lowReminder

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Remind me to unplug at", selection: $unplugAt) {
                        Text("Never").tag(0)
                        Text("80%").tag(80)
                        Text("85%").tag(85)
                        Text("90%").tag(90)
                    }
                    Toggle("Remind me near 20%", isOn: $lowReminder)
                } footer: {
                    Text("iOS doesn't let apps watch the battery in the background, so Battery Speed works out when the level should get there from how fast it has been moving, and sets a reminder for then. It is redone each time you open the app.")
                }
                Section {
                    Button("Send Test Notification") { Reminders.sendTest() }
                }
            }
            .navigationTitle("Reminders")
            .onChange(of: unplugAt) { _, value in
                Reminders.unplugAt = value
                Reminders.reschedule(for: monitor)
            }
            .onChange(of: lowReminder) { _, value in
                Reminders.lowReminder = value
                Reminders.reschedule(for: monitor)
            }
        }
    }
}
