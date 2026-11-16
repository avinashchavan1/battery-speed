package com.batteryspeed.app

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import kotlin.math.abs
import kotlin.math.roundToInt

enum class Plug(val label: String) {
    NONE("Not plugged in"),
    AC("Wall charger"),
    USB("USB port"),
    WIRELESS("Wireless charger"),
    DOCK("Dock"),
}

/** One battery reading in plain units. Fields a phone does not report are null. */
data class Reading(
    val ts: Long,
    val percent: Int,
    val plug: Plug,
    val systemStatus: Int, // BatteryManager.BATTERY_STATUS_*
    /** Current into the battery (+) or out of it (-), in mA. */
    val currentMa: Int?,
    val voltageMv: Int?,
    val tempC: Double?,
    /** Charge in the battery now, and what a full charge holds today, in mAh. */
    val chargeMah: Int?,
    val fullMah: Int?,
    val cycles: Int?,
    val health: String,
    /** The system's own estimate of time until full, in minutes. */
    val systemToFullMin: Int?,
    val powerSaver: Boolean,
) {
    /** Power into (+) or out of (-) the battery, in watts. */
    val watts: Double?
        get() = if (currentMa != null && voltageMv != null) currentMa * voltageMv / 1_000_000.0 else null

    val plugged: Boolean get() = plug != Plug.NONE
}

/**
 * Reads the battery through the public Android APIs. Phones differ in how they
 * report current (microamps on most, milliamps on some, with the sign flipped
 * on others), so the reader learns each phone's habit and corrects for it.
 */
object BatteryReader {
    private const val PREFS = "battery-reader"
    private const val KEY_UNPLUGGED = "raw-sign-unplugged" // sign of the raw reading on battery
    private const val KEY_CHARGING = "raw-sign-charging" // sign of the raw reading while charging
    private const val MIN_REAL_CAPACITY_MAH = 500 // real phone batteries hold 1,000 mAh or more

    fun read(context: Context): Reading {
        val intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val manager = context.getSystemService(BatteryManager::class.java)
        val power = context.getSystemService(PowerManager::class.java)

        val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, 100)?.takeIf { it > 0 } ?: 100
        val percent = if (level >= 0) (level * 100f / scale).roundToInt() else 0
        val plug = when (intent?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) {
            BatteryManager.BATTERY_PLUGGED_AC -> Plug.AC
            BatteryManager.BATTERY_PLUGGED_USB -> Plug.USB
            BatteryManager.BATTERY_PLUGGED_WIRELESS -> Plug.WIRELESS
            8 -> Plug.DOCK // BATTERY_PLUGGED_DOCK, Android 14+
            else -> Plug.NONE
        }
        val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, BatteryManager.BATTERY_STATUS_UNKNOWN)
            ?: BatteryManager.BATTERY_STATUS_UNKNOWN

        // Some phones report volts instead of millivolts.
        val voltageMv = intent?.getIntExtra(BatteryManager.EXTRA_VOLTAGE, -1)
            ?.takeIf { it > 0 }
            ?.let { if (it < 100) it * 1000 else it }
        val tempC = intent?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)
            ?.takeIf { it != Int.MIN_VALUE && it > -400 }
            ?.let { it / 10.0 }

        val currentMa = readCurrentMa(context, manager, plug, status)
        var chargeMah = manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER)
            .takeIf { it > 0 && it != Int.MIN_VALUE }
            ?.let { it / 1000 }
        // What a full charge holds today, worked out from the charge and the level.
        var fullMah = if (chargeMah != null && percent >= 10) chargeMah * 100 / percent else null
        // Some phones (and the emulator) report a charge counter that can't be real.
        if (fullMah != null && fullMah < MIN_REAL_CAPACITY_MAH) {
            chargeMah = null
            fullMah = null
        }

        val cycles = if (Build.VERSION.SDK_INT >= 34) {
            intent?.getIntExtra(BatteryManager.EXTRA_CYCLE_COUNT, -1)?.takeIf { it >= 0 }
        } else null
        val toFull = if (Build.VERSION.SDK_INT >= 28) {
            manager.computeChargeTimeRemaining().takeIf { it > 0 }?.let { (it / 60_000).toInt() }
        } else null

        return Reading(
            ts = System.currentTimeMillis(),
            percent = percent,
            plug = plug,
            systemStatus = status,
            currentMa = currentMa,
            voltageMv = voltageMv,
            tempC = tempC,
            chargeMah = chargeMah,
            fullMah = fullMah,
            cycles = cycles,
            health = healthLabel(intent?.getIntExtra(BatteryManager.EXTRA_HEALTH, 0) ?: 0),
            systemToFullMin = toFull,
            powerSaver = power.isPowerSaveMode,
        )
    }

    /**
     * Current into (+) or out of (-) the battery in mA. Phones disagree on the
     * sign: most report out as negative, some flip it, and some report only the
     * size with no direction at all. The reader learns which by noting the raw
     * sign on battery and while charging, and corrects for it.
     */
    private fun readCurrentMa(context: Context, manager: BatteryManager, plug: Plug, status: Int): Int? {
        val raw = manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW)
        if (raw == Int.MIN_VALUE || raw == 0) return null // not reported by this phone
        // Microamps on most phones; a few report milliamps. A phone in use draws
        // well over 10 mA, so a small number means the unit is already mA.
        val ma = if (abs(raw) < 10_000) raw else raw / 1000

        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val charging = plug != Plug.NONE && status == BatteryManager.BATTERY_STATUS_CHARGING
        if (abs(ma) > 30) {
            val key = when {
                plug == Plug.NONE -> KEY_UNPLUGGED
                charging -> KEY_CHARGING
                else -> null
            }
            if (key != null && !prefs.contains(key)) prefs.edit().putInt(key, if (ma > 0) 1 else -1).apply()
        }
        val unplugged = prefs.getInt(KEY_UNPLUGGED, 0)
        val whileCharging = prefs.getInt(KEY_CHARGING, 0)

        // Same sign on battery and while charging: the phone gives size only.
        // Take the direction from the plug state instead.
        if (unplugged != 0 && unplugged == whileCharging) {
            return when {
                plug == Plug.NONE -> -abs(ma)
                charging -> abs(ma)
                else -> null // plugged in but not charging: direction unknown
            }
        }
        // Otherwise the sign is real; make "out of the battery" negative.
        val flip = if (unplugged > 0 || whileCharging < 0) -1 else 1
        return ma * flip
    }

    private fun healthLabel(code: Int) = when (code) {
        BatteryManager.BATTERY_HEALTH_GOOD -> "Good"
        BatteryManager.BATTERY_HEALTH_OVERHEAT -> "Overheating"
        BatteryManager.BATTERY_HEALTH_DEAD -> "Worn out"
        BatteryManager.BATTERY_HEALTH_OVER_VOLTAGE -> "Over voltage"
        BatteryManager.BATTERY_HEALTH_COLD -> "Too cold"
        BatteryManager.BATTERY_HEALTH_UNSPECIFIED_FAILURE -> "Fault reported"
        else -> "Not reported"
    }
}
