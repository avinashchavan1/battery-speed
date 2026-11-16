package com.batteryspeed.app

import android.os.BatteryManager
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.roundToInt

enum class State { CHARGING, DRAINING_ON_CHARGER, HOLDING, FULL, ON_BATTERY }

enum class Severity { GOOD, WARNING, CRITICAL, NEUTRAL }

/** What a reading means, in words, with the time estimate. */
data class Verdict(
    val state: State,
    val severity: Severity,
    val label: String,
    val headline: String,
    val meaning: String,
    val etaMin: Int?,
    val etaKind: String?, // "empty" or "full"
    val smoothedMa: Int?,
)

/**
 * Same rules as the desktop app: smooth the current over about a minute,
 * classify what the battery is doing, and estimate time left.
 */
class Estimator {
    private var ema: Double? = null
    private var lastTs = 0L
    private var lastFlow = ""

    fun update(r: Reading): Verdict {
        val ma = r.currentMa
        var smoothed: Int? = null
        if (ma != null) {
            val flow = "${r.plugged}:${if (abs(ma) < DEAD_BAND_MA) 0 else if (ma > 0) 1 else -1}"
            val prev = ema
            ema = if (prev == null || flow != lastFlow) {
                ma.toDouble()
            } else {
                val alpha = 1 - exp(-(r.ts - lastTs).coerceAtLeast(0) / TAU_MS)
                prev + alpha * (ma - prev)
            }
            lastFlow = flow
            lastTs = r.ts
            smoothed = ema?.roundToInt()
        }
        val state = classify(r, smoothed)
        val (eta, kind) = estimate(r, state, smoothed)
        val words = describe(r, state, eta)
        return Verdict(state, words.severity, words.label, words.headline, words.meaning, eta, kind, smoothed)
    }

    private fun classify(r: Reading, ma: Int?): State {
        if (!r.plugged) return State.ON_BATTERY
        if (r.systemStatus == BatteryManager.BATTERY_STATUS_FULL || (r.percent >= 100 && (ma == null || abs(ma) < DEAD_BAND_MA))) {
            return State.FULL
        }
        if (ma == null) {
            // Without a current reading, trust the system's own status.
            return if (r.systemStatus == BatteryManager.BATTERY_STATUS_CHARGING) State.CHARGING else State.HOLDING
        }
        return when {
            ma > DEAD_BAND_MA -> State.CHARGING
            ma < -DEAD_BAND_MA -> State.DRAINING_ON_CHARGER
            else -> State.HOLDING
        }
    }

    private fun estimate(r: Reading, state: State, ma: Int?): Pair<Int?, String?> {
        if (state == State.CHARGING) {
            r.systemToFullMin?.let { return it to "full" } // the system knows its own charging curve
            if (ma != null && ma > 0 && r.chargeMah != null && r.fullMah != null) {
                // At today's rate up to 80%, then about half as fast.
                val knee = r.fullMah * 0.8
                val fast = (knee - r.chargeMah).coerceAtLeast(0.0)
                val taper = r.fullMah - maxOf(r.chargeMah.toDouble(), knee)
                return ((fast / ma + taper / (ma * 0.5)) * 60).roundToInt() to "full"
            }
        }
        if ((state == State.ON_BATTERY || state == State.DRAINING_ON_CHARGER) && ma != null && ma < 0 && r.chargeMah != null) {
            return (r.chargeMah.toDouble() / -ma * 60).roundToInt() to "empty"
        }
        return null to null
    }

    private data class Words(val severity: Severity, val label: String, val headline: String, val meaning: String)

    private fun describe(r: Reading, state: State, eta: Int?): Words {
        val w = r.watts?.let { abs(it) }
        val power = w?.let { " at ${"%.1f".format(it)} W" } ?: ""
        val time = eta?.let { duration(it) }
        val charger = r.plug.label.lowercase()
        return when (state) {
            State.CHARGING -> Words(
                Severity.GOOD, "Charging", "Charging$power",
                "The $charger gives more than the phone needs, and the extra is filling the battery." +
                    (time?.let { " It will be full in about $it." } ?: ""),
            )
            State.DRAINING_ON_CHARGER -> Words(
                Severity.WARNING, "Draining on charger", "Plugged in, but the battery is still draining",
                "The $charger cannot keep up with what the phone is doing, so the battery goes down even though it is plugged in." +
                    (time?.let { " At this rate it is empty in about $it." } ?: "") +
                    " A stronger charger, or closing heavy apps, stops the drain.",
            )
            State.HOLDING -> Words(
                Severity.NEUTRAL, "Not charging", "Plugged in, holding at ${r.percent}%",
                "The $charger is running the phone on its own, and the battery is resting. Phones often pause charging to protect the battery.",
            )
            State.FULL -> Words(
                Severity.GOOD, "Full", "Fully charged",
                "The battery is full. The $charger is running the phone on its own.",
            )
            State.ON_BATTERY -> {
                val severity = when {
                    r.percent <= 10 -> Severity.CRITICAL
                    r.percent <= 20 -> Severity.WARNING
                    else -> Severity.NEUTRAL
                }
                Words(
                    severity,
                    if (r.percent <= 20) "Battery low" else "On battery",
                    "Running on battery",
                    "Nothing is plugged in, so the battery is powering everything" +
                        (w?.let { ", about ${"%.1f".format(it)} W right now" } ?: "") + "." +
                        (time?.let { " At this rate it lasts about $it." } ?: ""),
                )
            }
        }
    }

    companion object {
        private const val TAU_MS = 45_000.0
        private const val DEAD_BAND_MA = 30
    }
}

fun duration(min: Int): String = when {
    min < 1 -> "under 1 min"
    min < 60 -> "$min min"
    min > 24 * 60 -> "over 24 h"
    min % 60 == 0 -> "${min / 60} h"
    else -> "${min / 60} h ${min % 60} min"
}
