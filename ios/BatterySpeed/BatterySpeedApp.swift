import BackgroundTasks
import SwiftUI
import UserNotifications

@main
struct BatterySpeedApp: App {
    @State private var monitor = BatteryMonitor()
    @Environment(\.scenePhase) private var phase

    init() {
        // A few times a day, when iOS allows it, record a reading and redo the
        // reminder estimates. iOS decides when; it is not a continuous watch.
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.refreshID, using: nil) { task in
            Task { @MainActor in
                let monitor = BatteryMonitor()
                monitor.refresh()
                Reminders.reschedule(for: monitor)
                Self.scheduleRefresh()
                task.setTaskCompleted(success: true)
            }
        }
        UNUserNotificationCenter.current().delegate = NotificationPresenter.shared
    }

    var body: some Scene {
        WindowGroup {
            ContentView(monitor: monitor)
                .task { _ = await Reminders.requestPermission() }
        }
        .onChange(of: phase) { _, newPhase in
            if newPhase == .active { monitor.refresh() }
            if newPhase == .background {
                Reminders.reschedule(for: monitor)
                Self.scheduleRefresh()
            }
        }
    }

    static let refreshID = "com.batteryspeed.ios.refresh"

    static func scheduleRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: refreshID)
        request.earliestBeginDate = Date.now.addingTimeInterval(30 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }
}

/// Shows reminders as banners even while the app is open.
final class NotificationPresenter: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationPresenter()

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }
}
