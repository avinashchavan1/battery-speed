package com.batteryspeed.app

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/** User choices, kept in shared preferences. */
class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var monitoring: Boolean
        get() = prefs.getBoolean("monitoring", true)
        set(value) = prefs.edit().putBoolean("monitoring", value).apply()

    var alerts: Boolean
        get() = prefs.getBoolean("alerts", true)
        set(value) = prefs.edit().putBoolean("alerts", value).apply()

    /** Unplug reminder level, or 0 for never. */
    var unplugAt: Int
        get() = prefs.getInt("unplugAt", 80)
        set(value) = prefs.edit().putInt("unplugAt", value).apply()

    fun lastFired(kind: String) = prefs.getLong("fired:$kind", 0L)
    fun markFired(kind: String, ts: Long) = prefs.edit().putLong("fired:$kind", ts).apply()
}

object Channels {
    const val STATUS = "status"
    const val ALERTS = "alerts"

    fun create(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(STATUS, "Battery status", NotificationManager.IMPORTANCE_LOW).apply {
                description = "The live battery readout while monitoring is on."
                setShowBadge(false)
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(ALERTS, "Battery alerts", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Low battery, a charger that can't keep up, and the unplug reminder."
            },
        )
    }

    fun openApp(context: Context): PendingIntent = PendingIntent.getActivity(
        context, 0,
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
}

/**
 * The alert rules, matching the desktop app. Each fires on a change and then
 * stays quiet for its cooldown, so one situation never becomes a stream.
 */
class Alerts(private val context: Context) {
    private val settings = Settings(context)
    private var prevPercent: Int? = null
    private var prevState: State? = null
    private var drainSince: Long? = null

    fun evaluate(r: Reading, v: Verdict) {
        val prev = prevPercent
        val losing = v.state == State.ON_BATTERY || v.state == State.DRAINING_ON_CHARGER
        val crossedDown = { level: Int -> losing && r.percent <= level && (prev == null || prev > level) }
        drainSince = if (v.state == State.DRAINING_ON_CHARGER) (drainSince ?: r.ts) else null
        val left = if (v.etaKind == "empty" && v.etaMin != null) " About ${duration(v.etaMin)} left." else ""

        if (drainSince != null && r.ts - drainSince!! >= 3 * MIN) {
            fire("draining", 45 * MIN, "warning", "Charger can't keep up",
                "Your phone is plugged in but still losing charge${r.watts?.let { ", about ${"%.1f".format(-it)} W" } ?: ""}. " +
                    "Use a stronger charger or close heavy apps.$left", r.ts)
        }
        if (crossedDown(10)) {
            fire("low_10", 30 * MIN, "critical", "Battery at ${r.percent}%", "Plug in soon.$left", r.ts)
        } else if (crossedDown(20)) {
            fire("low_20", 30 * MIN, "warning", "Battery at ${r.percent}%", "Running low.$left", r.ts)
        }
        val unplugAt = settings.unplugAt
        if (unplugAt > 0 && v.state == State.CHARGING && prev != null && prev < unplugAt && r.percent >= unplugAt) {
            fire("unplug", 6 * 60 * MIN, "good", "Charged to $unplugAt%, good time to unplug",
                "Batteries wear more slowly when they are not kept full, so unplugging around here helps it last.", r.ts)
        }
        if (v.state == State.FULL && prevState != null && prevState != State.FULL) {
            fire("full", 6 * 60 * MIN, "good", "Fully charged", "The battery is at 100%.", r.ts)
        }
        prevPercent = r.percent
        prevState = v.state
    }

    private fun fire(kind: String, cooldown: Long, severity: String, title: String, body: String, ts: Long) {
        if (ts - settings.lastFired(kind) < cooldown) return
        settings.markFired(kind, ts)
        Store.get(context).addAlert(SavedAlert(ts, severity, title, body))
        if (settings.alerts) notify(context, kind.hashCode(), title, body)
    }

    companion object {
        private const val MIN = 60_000L

        fun notify(context: Context, id: Int, title: String, body: String) {
            val allowed = Build.VERSION.SDK_INT < 33 ||
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
            if (!allowed) return
            val notification = NotificationCompat.Builder(context, Channels.ALERTS)
                .setSmallIcon(R.drawable.ic_bolt)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setContentIntent(Channels.openApp(context))
                .setAutoCancel(true)
                .build()
            NotificationManagerCompat.from(context).notify(1000 + (id and 0xFFF), notification)
        }
    }
}
