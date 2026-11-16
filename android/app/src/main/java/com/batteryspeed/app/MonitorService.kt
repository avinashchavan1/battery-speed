package com.batteryspeed.app

import android.app.Notification
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import kotlin.math.abs

/**
 * Background monitoring, on while the user leaves it on. It reads the battery
 * when the system reports a change and every 30 seconds in between, saves
 * history, raises alerts, and keeps a quiet notification with the live status,
 * the phone's equivalent of the Mac's menu bar readout.
 */
class MonitorService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private val estimator = Estimator()
    private lateinit var alerts: Alerts

    private val batteryChanged = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) = tick()
    }
    private val poll = object : Runnable {
        override fun run() {
            tick()
            handler.postDelayed(this, POLL_MS)
        }
    }

    override fun onCreate() {
        super.onCreate()
        Channels.create(this)
        alerts = Alerts(this)
        val first = status(BatteryReader.read(this).let { it to estimator.update(it) })
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(STATUS_ID, first, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(STATUS_ID, first)
        }
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_BATTERY_CHANGED)
            addAction(Intent.ACTION_POWER_CONNECTED)
            addAction(Intent.ACTION_POWER_DISCONNECTED)
        }
        ContextCompat.registerReceiver(this, batteryChanged, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        handler.post(poll)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        handler.removeCallbacks(poll)
        unregisterReceiver(batteryChanged)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun tick() {
        val reading = BatteryReader.read(this)
        val verdict = estimator.update(reading)
        Store.get(this).record(reading, verdict)
        alerts.evaluate(reading, verdict)
        NotificationManagerCompat.from(this).let {
            if (it.areNotificationsEnabled()) it.notify(STATUS_ID, status(reading to verdict))
        }
    }

    /** The always-on notification: charge, what it is doing, and time left. */
    private fun status(rv: Pair<Reading, Verdict>): Notification {
        val (r, v) = rv
        val watts = r.watts?.let { " · ${"%.1f".format(abs(it))} W" } ?: ""
        val title = "${r.percent}% · ${v.label}$watts"
        val text = when {
            v.etaMin != null && v.etaKind == "full" -> "Full in about ${duration(v.etaMin)}"
            v.etaMin != null -> "About ${duration(v.etaMin)} left"
            else -> v.headline
        }
        return NotificationCompat.Builder(this, Channels.STATUS)
            .setSmallIcon(R.drawable.ic_bolt)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setContentIntent(Channels.openApp(this))
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    companion object {
        private const val STATUS_ID = 1
        private const val POLL_MS = 30_000L

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, MonitorService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, MonitorService::class.java))
        }
    }
}

/** Starts monitoring again after the phone restarts, if the user has it on. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED && Settings(context).monitoring) {
            MonitorService.start(context)
        }
    }
}
