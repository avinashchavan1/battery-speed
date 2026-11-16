import Foundation
import UserNotifications

/// iOS does not let apps watch the battery in the background, so reminders
/// are scheduled ahead: from how fast the level is moving, work out when it
/// will reach the unplug level (or run low), and set a notification for then.
/// Each time the app runs, the estimate is redone.
@MainActor
enum Reminders {
    static let unplugKey = "unplugAt"
    static let lowKey = "lowReminder"

    static var unplugAt: Int {
        get { UserDefaults.standard.object(forKey: unplugKey) as? Int ?? 80 }
        set { UserDefaults.standard.set(newValue, forKey: unplugKey) }
    }

    static var lowReminder: Bool {
        get { UserDefaults.standard.object(forKey: lowKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: lowKey) }
    }

    static func requestPermission() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])) ?? false
    }

    /// Replaces the scheduled estimates with fresh ones.
    static func reschedule(for monitor: BatteryMonitor) {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: ["unplug", "low"])
        guard !monitor.demo else { return }

        if monitor.state == .charging, unplugAt > 0, let minutes = monitor.minutes(until: unplugAt) {
            schedule("unplug", after: minutes,
                     title: "Probably at \(unplugAt)% now",
                     body: "A good time to unplug: batteries wear more slowly when they are not kept full. " +
                         "This is an estimate from how fast it was charging.")
        }
        if monitor.state == .onBattery, lowReminder, monitor.percent > 20, let minutes = monitor.minutes(until: 20) {
            schedule("low", after: minutes,
                     title: "Battery probably near 20%",
                     body: "Time to find a charger. This is an estimate from how fast the battery was going down.")
        }
    }

    static func sendTest() {
        schedule("test", after: 0.05, title: "Battery Speed notifications work",
                 body: "Reminders look like this. Tap one to open Battery Speed.")
    }

    private static func schedule(_ id: String, after minutes: Double, title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: max(3, minutes * 60), repeats: false)
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: trigger))
    }
}
